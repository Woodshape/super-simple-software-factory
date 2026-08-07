---
status: planned
---

# Vollständiger Tool-Verlauf in der Agent-Messages-Ansicht

## Ziel

Die vorhandene Messages-Ansicht des Visualizers wird von einem reinen Textstrom zu einem vollständigen, append-only Quellverlauf erweitert. Für konfigurierte Agents und Subagents zeigt sie `user`-, `thinking`- und `assistant`-Texte sowie jeden echten Tool-Aufruf und jedes Tool-Ergebnis — insbesondere `bash`, `read` und `write` — vollständig und in der Reihenfolge der Pi-Quelle. Die bestehende Actions-Ansicht bleibt unverändert und ist beim Öffnen sowie nach jedem Agentwechsel die Standardansicht; Messages wird nur über den vorhandenen Toggle eingeblendet.

Maßgebliche Quelle bleiben die sicheren Pi-JSONL-Dateien. SQLite-Events und `subagent_activities` sind für Actions bestimmte, teilweise gekürzte Projektionen und dürfen nicht zur Rekonstruktion des vollständigen Messages-Verlaufs verwendet werden. Producer, SQLite-Schema, Route und API-Aufruf existieren bereits und werden für diesen Fix nicht geändert.

## Aktueller Stand und maßgebliche Invarianten

- `server/messages.ts` löst Raw- und kompakte Fallback-Dateien bereits ADW-scoped, realpath-sicher und ohne Vermischung auf, normalisiert aktuell aber nur Textblöcke aus `message_end` beziehungsweise `message`.
- Ein Raw-Pi-Call erscheint üblicherweise zuerst als Assistant-`toolCall`-Block, danach noch einmal als `tool_execution_start`; sein vollständiges Ergebnis erscheint erst in `tool_execution_end`. Diese Doppelrepräsentation darf nur einen Call-Eintrag erzeugen. Das Ergebnis ist ein eigener, späterer Eintrag.
- Der kompakte `session.jsonl`-Fallback speichert Assistant-`toolCall`-Blöcke und eigene `{ type: "message", message.role: "toolResult" }`-Records. Raw und Fallback dürfen weiterhin nie kombiniert werden.
- Die sichtbare Ordnung ist Datei-, Record- und Content-Block-Reihenfolge, bei Subagents zusätzlich die numerische Turn-Reihenfolge. Zeitstempel dienen nur Anzeige und Phasenfilter, niemals zum Sortieren.
- Cursor bezeichnen normalisierte sichtbare Einträge. Bereits ausgelieferte Calls werden nicht nachträglich in Results umgewandelt oder erneut ausgegeben; ein späteres Result wird angehängt. Damit bleiben Cursor über Paging und Polling stabil.
- Tool-Argumente und textuelle Results sind Nutzinhalt und werden weder gekürzt noch redigiert. Provider-Signaturen, verschlüsselte Metadaten, interne Record-Felder und Quellpfade werden dagegen nicht pauschal serialisiert.

## Implementierungsplan

### 1. Gemeinsamen Vertrag als diskriminierte Entry-Union erweitern

**Datei:** `.agents/skills/sssf/apps/visualizer/shared/types.ts`

Ersetze den text-only `AgentMessage`-Vertrag durch eine über `role` diskriminierte Union mit einem gemeinsamen Basisteil (`cursor`, opaque `id`, optional `timestamp`, optional `turn`):

- Text-Entry: `role: "user" | "thinking" | "assistant"` und vollständiges `text`.
- Tool-Call-Entry: `role: "tool_call"`, `tool`, `tool_call_id` und vollständiges `arguments_json`. Der Server serialisiert ausschließlich den tatsächlichen `arguments`-/`args`-Wert als ungekürztes JSON; der Client muss den String nicht erneut interpretieren, um ihn anzuzeigen.
- Tool-Result-Entry: `role: "tool_result"`, `tool`, `tool_call_id`, vollständiges `result` und `is_error`.

Erweitere `AgentMessageRole` entsprechend und dokumentiere, dass reale Provider-Call-IDs übernommen werden. Fehlt eine ID, liefert der Parser eine deterministische, nicht pfadbasierte synthetische ID. Behalte `AgentMessagesPage` mit `messages`, `cursor`, `has_more` und `available` bei, damit Route und `fetchAgentMessages` unverändert bleiben. `src/lib/types.ts` re-exportiert die Shared-Typen bereits und braucht keine zweite Definition.

### 2. Raw- und Fallback-Parser auf einen vollständigen append-only Verlauf umstellen

**Datei:** `.agents/skills/sssf/apps/visualizer/server/messages.ts`

Behalte Quellauflösung, Safe-Segment-/Realpath-Prüfungen, Raw-vor-Fallback-Regel, numerische Turn-Sortierung und Request-Paging bei. Ersetze die text-only Blockextraktion durch einen zustandsbehafteten Parser pro Quelldatei:

1. **Text und Call-Ankündigungen aus Raw-Records:**
   - Werte im Raw-Modus weiterhin nur finale `message_end`-Snapshots für User-/Assistant-Inhalte aus; `message_start`, Deltas und `turn_end` bleiben unsichtbar.
   - Übernimm User-`text`, Assistant-`thinking` und Assistant-`text` in ihrer Content-Block-Reihenfolge.
   - Erzeuge an der Position jedes Assistant-`toolCall`-Blocks einen `tool_call`-Entry mit `id`, `name` und den vollständigen `arguments`.
2. **Execution-Events:**
   - Nutze `tool_execution_start` nur dann als Call-Quelle, wenn dieselbe echte `toolCallId` noch nicht durch einen `toolCall`-Block ausgegeben wurde. `tool_execution_update` ist nur Streaming-Zwischenstand und bleibt unsichtbar.
   - Erzeuge aus jedem erstmaligen `tool_execution_end` einen separaten `tool_result`-Entry. Nimm Toolname und Call-ID aus dem Event beziehungsweise dem zuvor getrackten Call, `isError` als Fehlerstatus und füge alle textuellen `result.content`-Blöcke in Originalreihenfolge ohne Kürzung zusammen.
   - Falls nur ein End-Event für einen ansonsten unbekannten Call vorhanden ist, erzeuge aus dessen `toolName`/`args` unmittelbar davor auch den fehlenden Call-Entry, damit ein echter Call nicht verschwindet.
3. **Deduplizierung und fehlende IDs:**
   - Tracke Call- und Result-Emission getrennt nach echter Call-ID: Ankündigung plus Start ergibt genau einen Call, das End-Event genau ein Result. Result und Call teilen die Verknüpfungs-ID, bleiben aber zwei immutable Entries.
   - Gib anonymen Calls bei ihrem ersten belastbaren Auftreten eine deterministische synthetische ID aus Quellfile-Ordinal, Record-Ordinal und Block-Ordinal, ohne einen Dateipfad zu veröffentlichen. Ordne nachfolgende anonyme Start-/End-Events über die offene FIFO-Reihenfolge und übereinstimmenden Toolnamen/Argumente zu; bei fehlender eindeutiger Zuordnung lieber einen eigenen synthetischen echten Call behalten als einen Record verwerfen. Ergänze dafür einen expliziten Regressionstest.
4. **Kompakter Fallback:**
   - Parse bei `{ type: "message" }` dieselben User-/Assistant-Blöcke einschließlich Assistant-`toolCall`.
   - Parse `message.role === "toolResult"` als eigenen `tool_result` aus `toolCallId`, `toolName`, `content` und `isError`. Bewahre die Record-Reihenfolge; mische diese Einträge nie zusätzlich mit vorhandenen Raw-Turns.
5. **Vollständigkeit und Sicherheit:**
   - Serialisiere für Calls nur den Argumentwert und für Results nur textuelle Contentblöcke. Übernimm nicht den gesamten Provider-Record; dadurch gelangen `thinkingSignature`, `encrypted_content`, `fixture_path`, `details`, absolute Speicherpfade oder andere interne Metadaten nicht unbeabsichtigt in die API.
   - Leere, mehrzeilige und sehr lange Argument-/Result-Strings bleiben gültig. Es gibt weder `20_000`-Zeichen-Clipping noch Snippet-Fallback aus SQLite.
   - Isoliere weiterhin jede fehlerhafte JSONL-Zeile. Eine unvollständige letzte Live-Zeile erzeugt noch keinen Entry und erscheint nach ihrer Vervollständigung beim nächsten Poll genau einmal.
6. **Phasenfilter:**
   - Verknüpfe Raw-Start/End-Events intern mit der Timestamp-/Phasenzugehörigkeit ihrer Call-Ankündigung. Call und Result eines konfigurierten Agents werden gemeinsam ein- oder ausgeschlossen, wenn eine Pi-Session über mehrere Phasen wiederverwendet wird.
   - Für kompakte Records nutze deren Message-/Record-Timestamp; bei verknüpften Results hat die Zugehörigkeit des Calls Vorrang. Unzuordenbare Records ohne auswertbaren Timestamp dürfen bei aktivem Phasenfenster nicht in eine fremde Phase durchsickern.
7. **Cursor:**
   - Weise nach vollständiger Normalisierung wieder strikt 1-basige Cursor in sichtbarer Quellreihenfolge zu. IDs dürfen auf der sichtbaren Position basieren, aber nie auf einem Dateipfad.
   - Schneide erst danach über `after`/`limit`. Ein unverändertes Quellpräfix muss bei jedem Request identische Cursor und Inhalte liefern; neu abgeschlossene Records werden ausschließlich hinten angehängt.

### 3. Client-Normalisierung gegen Lücken, Sprünge und Duplikate härten

**Datei:** `.agents/skills/sssf/apps/visualizer/src/lib/messages.ts`

- Validiere jede Variante der neuen Union separat: Text braucht `text`, Call braucht `tool`, `tool_call_id` und `arguments_json`, Result braucht `tool`, `tool_call_id`, `result` und boolesches `is_error`. Übernimm gültige Strings bytegetreu und ignoriere unbekannte Rollen oder unvollständige Varianten.
- Sortiere und dedupliziere weiterhin nach Cursor. Bei einem Konflikt desselben Cursors bleibt der bereits angezeigte immutable Entry erhalten; der Server darf Calls nicht nachträglich an derselben Position zu Results mutieren.
- Vertraue einem gelieferten Seiten-Cursor nicht unabhängig von den validierten Entries. Fortschritt darf höchstens bis zum höchsten lückenlos ab `after + 1` validierten Cursor gehen; ein Server-Cursor-Sprung ohne die zugehörigen Einträge darf keine Messages überspringen. `has_more` darf in der Lade-Schleife nur bei tatsächlichem Cursorfortschritt zu einer Folgeseite führen.
- Halte `mergeAgentMessagePage` und `mergeAgentMessages` auf derselben Semantik und nutze den gemeinsamen keyed State im Component-Pfad, statt Cursor-/Merge-Regeln abweichend zu duplizieren. Ein Agent-Key-Wechsel startet weiterhin bei Cursor 0 mit leerem Inhalt.

### 4. Actions als Standard setzen und Toggle-Verhalten erhalten

**Datei:** `.agents/skills/sssf/apps/visualizer/src/components/AgentDetail.vue`

- Initialisiere `mode` mit `actions` und setze ihn im bestehenden `watch(messageKey, ...)` bei jedem konfigurierten Agent-/Subagent-Wechsel ebenfalls auf `actions` zurück.
- Behalte den zugänglichen `Messages | Actions`-Toggle und die `aria-pressed`-Zustände. Messages wird ausschließlich nach explizitem Klick gerendert.
- Lass beide Actions-Zweige unverändert: konfigurierte Agents verwenden weiter `ConfiguredAgentDetail`, Subagents weiter Facts, Turns und `ToolCallRow`. Nicht-agentische konfigurierte Phasen bleiben ohne Toggle in ihrer bisherigen Actions-Darstellung.
- Behalte den `adw_id:agent_id`-Key von `AgentMessageFlow`, damit ein vorheriger Agent weder Messages noch Polling-State in ein neues Detail überträgt.

### 5. Tool-Entries vollständig darstellen und Live-Abschluss zuverlässig drainen

**Datei:** `.agents/skills/sssf/apps/visualizer/src/components/AgentMessageFlow.vue`

1. **Darstellung:**
   - Ergänze Labels und visuell unterscheidbare Klassen für `Tool Call` und `Tool Result`.
   - Rendere bei Calls Toolname, Call-ID und `arguments_json`; bei Results Toolname, dieselbe Call-ID, klaren Success/Error-Status und `result`. User-/Thinking-/Assistant-Einträge behalten ihre heutige Textdarstellung.
   - Verwende ausschließlich Vue-Textinterpolation. Argumente und Results erhalten `white-space: pre-wrap` und `overflow-wrap: anywhere`; keine Ellipsis, feste `max-height` oder Snippet-Ansicht darf Inhalt abschneiden.
   - Aktualisiere Leerzustände auf „noch keine Einträge“ statt nur drei Textrollen. Wenn `available === false` und der Agent läuft, zeige einen vorläufigen „Stream noch nicht verfügbar“-Zustand und poll weiter; erst bei terminalem Status darf der Hinweis einen Legacy-/fehlenden Stream benennen.
2. **Paging und Polling:**
   - Führe Seiten sequentiell ab dem letzten lückenlos akzeptierten Cursor zusammen und nutze die Helper aus `src/lib/messages.ts`. Überlappende Responses dürfen Calls/Results nicht doppeln.
   - Erhalte Generation-Token, In-flight-Schutz, Timer-Cleanup und Reset bei Agentwechsel/Unmount.
   - Poll während `running` weiter, auch wenn die Raw-Datei beim ersten Request noch nicht existiert.
3. **Terminaler Final-Drain:**
   - Beim Übergang `running: true -> false` führe genau einen abschließenden Catch-up-Lauf ab dem aktuellen Cursor aus, statt nur den Timer zu löschen. Der Drain lädt ebenfalls alle `has_more`-Seiten.
   - Falls beim Statuswechsel bereits ein Request läuft, merke einen pending Final-Drain und starte ihn nach dessen `finally`; verliere ihn nicht am `inFlight`-Guard. Der Abschlussabruf plant keinen weiteren Poll.
   - Generation-Wechsel und Unmount annullieren auch einen vorgemerkten Drain. Cursor-Deduplizierung macht einen überlappenden letzten Poll plus Drain exact-once sichtbar.

## Tests

### Server-Parser

**Datei:** `.agents/skills/sssf/apps/visualizer/server/messages.test.ts`

Ersetze die bisherige Erwartung „Tools werden verworfen“ durch realistische Raw- und kompakte Fixtures:

1. Ein Verlauf mit `user`, `thinking`, `assistant` sowie `bash`, `read` und `write` enthält jeden Call und jedes Result exakt einmal. `toolCall` plus `tool_execution_start` darf den Call nicht duplizieren; Results bleiben in tatsächlicher End-Event-Reihenfolge.
2. Vollständige verschachtelte Argumente, Commands/Pfade, mehrzeilige Resultate, leere Resultate, Error-Results und Strings deutlich über 20.000 Zeichen kommen unverändert an. Separate Sentinel-Felder für Signatur, Verschlüsselung, Fixture-/Quellpfad und Provider-`details` erscheinen nicht in der Response.
3. Page einen Call aus, hänge anschließend sein `tool_execution_end` an und frage mit dem alten Cursor weiter: Es erscheint nur das neue Result, ohne Lücke, Call-Wiederholung oder Cursoränderung im Präfix. Wiederhole mit mehr als `limit` Einträgen, einer überlappenden Seite und einem zunächst unvollständigen Live-Tail.
4. Subagent-Turns bleiben numerisch (`turn-2` vor `turn-10`), und vorhandene Raw-Dateien verhindern weiterhin jede Beimischung aus `session.jsonl`.
5. Der kompakte Fallback liefert Assistant-`toolCall` und `toolResult` in derselben Union und Quellreihenfolge.
6. Zwei Phasen desselben konfigurierten Owners isolieren jeweils Texte, Calls und Results; undatierte verwaiste Execution-Events lecken nicht in das Phasenfenster.
7. Fehlende Call-IDs erhalten stabile synthetische IDs und werden über Ankündigung/Start/End genau einmal als Call plus Result gezeigt.
8. Malformed lines, missing files, unsafe Segmente und Symlink-Escapes bleiben abgedeckt.

### HTTP-Vertrag

**Datei:** `.agents/skills/sssf/apps/visualizer/server/app.test.ts`

- Erweitere die Unified-Agent-Fixture für konfigurierte und nested Agents um echte `bash`-/`read`-/`write`-Calls und Results.
- Frage beide Quellen über mehrere Seiten ab und erwarte dieselbe diskriminierte Union, vollständige Inhalte, stabile Cursor und keine Duplikate.
- Prüfe weiterhin 200/`available: false` für bekannte Agents ohne sichere Datei, 400 für ungültige IDs/Cursor/Limits und 404 bei ADW-Mismatch.
- Prüfe am serialisierten HTTP-Body, dass Provider-Signaturen und interne Fixture-Pfade fehlen, während ein bewusst als Tool-Argument verwendeter Command oder Pfad vollständig enthalten ist.

### Client-Paging

**Datei:** `.agents/skills/sssf/apps/visualizer/src/lib/messages.test.ts`

- Teste Normalisierung aller fünf Rollen einschließlich langer/multiline `arguments_json`- und `result`-Strings sowie Error-Status.
- Teste überlappende Seiten und getrennt eintreffende Call-/Result-Einträge auf stabile Reihenfolge und exact-once Merge.
- Teste malformed Varianten einzeln, Cursor-Lücken und einen behaupteten Cursor-Sprung: Kein gültiger, noch nicht geladener Bereich darf übersprungen werden, und eine nicht fortschreitende Seite verursacht keine endlose Backlog-Schleife.
- Behalte den Agent-Key-Reset-Test und erweitere ihn so, dass auch Tool-Entries des vorherigen Agents nicht übernommen werden.

Das Projekt hat derzeit keine Vue-SFC-Mount-Testinfrastruktur. Führe für Default-/Reset-Toggle, Statuswechsel und Final-Drain deshalb die unten beschriebenen manuellen Akzeptanzschritte aus, statt für diesen gezielten Fix eine neue Test-Runner-/DOM-Abhängigkeit einzuführen. Die Parser-, HTTP- und Client-Tests decken die Daten- und Cursorinvarianten automatisiert ab.

## Verifikation

Aus `.agents/skills/sssf/apps/visualizer` ausführen und jeden Exit-Status prüfen:

```bash
bun test
bun run typecheck
bun run lint
bun run build
```

Danach mit einem laufenden Test-ADW prüfen, dessen konfigurierter Agent und Subagent jeweils `bash`, `read` und `write` verwenden:

1. Jedes Detail öffnet in `Actions`; auch nach Wechsel zwischen Agent und Subagent ist `Actions` erneut aktiv und die bisherige Actions-Darstellung vollständig nutzbar.
2. Erst der Klick auf `Messages` öffnet den Flow. Texte, Calls und Results stimmen vom ersten User-Text bis zum letzten Result mit Raw-JSONL beziehungsweise dem ausgewählten Fallback überein; Toolname, ID, vollständige Argumente, Result und Fehlerstatus sind sichtbar.
3. Während des Laufs erscheinen neue Calls und spätere Results in Quellreihenfolge genau einmal. Ein initial noch fehlender Raw-Stream wechselt ohne Reload in die befüllte Ansicht.
4. Beim Übergang zum terminalen Status erscheint auch ein unmittelbar danach geflushter letzter Result-/Assistant-Record durch den Final-Drain; erneutes Umschalten oder ein überlappender Poll dupliziert ihn nicht.
5. Erzeuge mehr als 200 sichtbare Entries und prüfe den Seitenübergang ohne Lücke/Duplikat. Wechsle während eines langsamen Requests den Agent und prüfe, dass keine alte Response eingeblendet wird.
6. Öffne einen terminalen Legacy-Agent ohne JSONL: Actions bleibt Standard und Messages zeigt den passenden nicht-verfügbar-Zustand.

## Akzeptanzkriterien

- Konfigurierte Agents und Subagents öffnen immer in Actions; Messages ist nur über den Toggle sichtbar.
- Messages zeigt alle User-/Thinking-/Assistant-Texte sowie jeden echten Tool Call und jedes Tool Result vollständig, sicher und in Originalreihenfolge.
- Derselbe Provider-Call erscheint trotz `toolCall` plus Execution-Events genau einmal als Call und einmal als späteres Result; lange Inhalte werden nicht gekürzt.
- Paging, laufendes Polling, Agentwechsel und der terminale Final-Drain verlieren oder duplizieren keine Einträge und überspringen keinen Cursorbereich.
- Actions, sichere Quellauflösung, Raw-vor-Fallback, Phasenfilter und bestehende Route bleiben intakt; alle Visualizer-Checks bestehen.

## Nicht Teil des Fixes

- keine Änderungen an `agent_pi.py`, Subagent-Produzenten, SQLite-Schema oder Trace-/Activity-Projektionen;
- keine Änderung der bestehenden Messages-Route oder des API-Clients, sofern der erweiterte Shared-Vertrag dort ohne Logikänderung durchgereicht wird;
- kein Umbau von `ConfiguredAgentDetail.vue`, `ToolCallRow.vue` oder der Actions-Daten;
- keine Aktualisierung allgemeiner README-/Observability-Dokumentation in diesem engen Fix;
- keine Überarbeitung oder Löschung der älteren `specs/91bda7f7_agent-message-stream.md`; diese neue Spec dokumentiert bewusst die geänderten Anforderungen.
