---
status: planned
---

# Vollständige Agent-Nachrichten im Visualizer

## Ziel

Die Detailansicht jedes konfigurierten Agents und jedes Subagents erhält eine gemeinsame, lesbare Nachrichtenansicht. Sie zeigt die tatsächlich von Pi aufgezeichneten `user`-, `thinking`- und `assistant`-Texte vollständig und in Quellreihenfolge. Diese Ansicht ist beim Öffnen eines Agent-Details die primäre Ansicht; die heutige kompakte Darstellung aus Events, Turn-Zusammenfassungen und Tool-Actions bleibt über einen Umschalter unverändert erreichbar.

Die vollständigen Inhalte werden nicht aus SQLite rekonstruiert: SQLite enthält nur Projektionen und gekürzte Tool-Snippets. Die bereits vorhandenen Pi-JSONL-Dateien sind die maßgebliche Quelle. Es sind weder eine Schema-Migration noch Änderungen an den Agent-/Subagent-Produzenten nötig.

## Umsetzung

### 1. Einen kleinen gemeinsamen Nachrichtenvertrag definieren

**Dateien:**

- `.agents/skills/sssf/apps/visualizer/shared/types.ts`
- `.agents/skills/sssf/apps/visualizer/src/lib/types.ts`

Ergänze gemeinsame Typen für:

- eine Rolle `user | thinking | assistant`;
- einen normalisierten Flow-Eintrag mit stabilem Cursor/ID, Rolle, vollständigem Text, optionalem Zeitstempel und optionaler Turn-Nummer;
- eine cursorbasierte Seite mit `messages`, `cursor`, `has_more` und `available`.

`thinking` muss dabei ausdrücklich den echten Reasoning-Text bezeichnen und darf nicht mit `AgentTurn.thinking` verwechselt werden, das nur den konfigurierten Thinking-Level enthält. Re-exportiere die neuen Typen über `src/lib/types.ts`, damit Server und UI denselben Vertrag verwenden.

### 2. Sicheren JSONL-Lader und Normalisierer als tiefes Server-Modul bauen

**Neue Datei:**

- `.agents/skills/sssf/apps/visualizer/server/messages.ts`

Kapsle Quellauflösung, Dateisicherheit, Parsing, Phasenfilter und Paging hinter einer kleinen Interface, die aus `sessionsDir` und einem bereits ADW-scoped `AgentDetail` eine normalisierte Nachrichtenseite liefert.

Quellen:

- Konfigurierter Agent: `{sessionsDir}/{adw_id}/{configured.agent}/raw_output.jsonl`.
- Subagent: `{sessionsDir}/{adw_id}/{nested.parent_agent}/subagents/{nested.subagent_id}/turn-{turn}/raw_output.jsonl`, anhand der numerisch sortierten Turns aus `AgentDetail.turns`.
- Falls ein Legacy-Lauf keine Raw-Datei, aber die entsprechende persistente Pi-`session.jsonl` besitzt, darf das Modul deren kompakte `{type: "message"}`-Records als Fallback lesen; Raw- und Session-Quelle dürfen nie gleichzeitig gemischt werden, damit nichts doppelt erscheint.

Sicherheits- und Scoping-Regeln:

- Keine Pfade aus Request-Parametern oder absolute `session_path`-/`raw_output_path`-Werte aus SQLite direkt öffnen.
- Alle verwendeten Segmente mit derselben Safe-Segment-Regel wie die Route prüfen.
- Jeden konstruierten Pfad lexikalisch und, für existierende Dateien, per Realpath unter dem konkreten `{sessionsDir}/{adw_id}`-Baum halten; Symlink-Escapes ablehnen.
- Weder Dateipfade noch rohe Events, Tool-Argumente/-Resultate, `thinkingSignature`, verschlüsselte Signaturen oder sonstige Provider-Metadaten serialisieren.
- Ein vorhandener Agent ohne passende Datei ergibt `available: false` und eine leere Seite, nicht einen Serverfehler.

Parsing-Regeln für Raw-Pi-Streams:

- Nur finale `message_end`-Records als maßgebliche Snapshots auswerten; `message_start`, `message_update` und das duplizierende `turn_end` ignorieren.
- Aus User-Nachrichten nur `text`-Blöcke als `user` übernehmen.
- Aus Assistant-Nachrichten `thinking`-Blöcke als `thinking` und `text`-Blöcke als `assistant` übernehmen, jeweils in Content-Block-Reihenfolge.
- Tool-Calls, Tool-Results, Custom-/System-Records, Bilder und unbekannte Blöcke nicht in diese Textansicht aufnehmen; sie bleiben in der Action-Ansicht.
- Text bytegetreu als String übernehmen: nicht trimmen, zusammenfassen oder auf 20.000 Zeichen kürzen.
- Dateireihenfolge, innerhalb eines Records die Blockreihenfolge und bei Subagents die numerische Turn-Reihenfolge bewahren; nicht nach möglicherweise gleichen/fehlenden Zeitstempeln umsortieren.
- Fehlerhafte vollständige Zeilen und eine gerade noch unvollständige letzte Live-Zeile überspringen, ohne spätere gültige Records oder die ganze Antwort zu verlieren.
- Bei konfigurierten Agents, deren Owner/Session über mehrere Phasen wiederverwendet wird, anhand von `started_at`/`ended_at` des ausgewählten `AgentDetail` filtern. So erscheinen in einem phasenspezifischen Detail keine späteren Nachrichten desselben Owners.

Cursor und `limit` beziehen sich auf die normalisierten sichtbaren Flow-Einträge. Ein einzelner Eintrag bleibt auch dann vollständig, wenn sein Text sehr groß ist. Neue finale Records eines laufenden Agents werden nur hinten angefügt, damit Polling keine Duplikate erzeugt.

### 3. Scoped Messages-Endpoint ergänzen

**Datei:**

- `.agents/skills/sssf/apps/visualizer/server/app.ts`

Füge hinzu:

`GET /api/sessions/:adw_id/agents/:agent_id/messages?after=<cursor>&limit=<limit>`

Verhalten:

- Pfadparameter über `validAgentIds()` validieren.
- Den Agent zuerst mit `db.agent(adwId, agentId)` auflösen; unbekannte Agents und ADW-Mismatches bleiben 404.
- `after` und `limit` wie bei Activity-Pages als nichtnegative, sichere Integer validieren und `limit` begrenzen.
- Erst danach das neue Nachrichtenmodul aufrufen und ausschließlich den normalisierten gemeinsamen Vertrag zurückgeben.
- Kein SQLite-Schema und keine vorhandene Detail-/Activity-Route verändern.

### 4. Client-Paging und Live-Merge hinzufügen

**Dateien:**

- `.agents/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.agents/skills/sssf/apps/visualizer/src/lib/messages.ts` (neu)
- `.agents/skills/sssf/apps/visualizer/src/lib/messages.test.ts` (neu)

Ergänze `fetchAgentMessages(adwId, agentId, after, limit)` analog zu `fetchAgentActivity`. Das neue Client-Modul normalisiert defensive Serverantworten und merged Cursor-Seiten stabil und dedupliziert. Es darf Text nicht kürzen oder Rollen umdeuten.

Teste im Client-Modul insbesondere:

- stabile Quellreihenfolge und Cursor-Deduplizierung über mehrere Seiten;
- vollständige mehrzeilige und sehr lange Texte;
- defensive Behandlung fehlerhafter Seiten/Felder;
- Zurücksetzen statt Vermischen, wenn der ausgewählte Agent wechselt.

### 5. Wiederverwendbare Fließtextansicht bauen

**Neue Datei:**

- `.agents/skills/sssf/apps/visualizer/src/components/AgentMessageFlow.vue`

Die Komponente erhält nur ADW-ID, Agent-ID und Laufstatus. Sie kapselt das Laden aller Backlog-Seiten und pollt nach dem letzten Cursor weiter, solange der ausgewählte Agent läuft. Beim Unmount oder Agent-Wechsel müssen Timer und alter Inhalt verworfen werden; parallele Requests dürfen keine Daten eines zuvor ausgewählten Agents einblenden.

Darstellung:

- semantische, chronologische Einträge mit klaren Labels für User, Thinking und Assistant sowie optional Zeit/Turn;
- vollständiger Text über sichere Vue-Textinterpolation, `white-space: pre-wrap` und `overflow-wrap: anywhere`;
- keine feste `max-height`, kein Ellipsis und kein Snippet, das den eigentlichen Nachrichtentext abschneidet;
- visuell unterscheidbare, aber gleichermaßen lesbare Rollen auf Desktop und schmalen Viewports;
- eigene Zustände für Laden, nicht verfügbar/Legacy, leer und Request-Fehler;
- keine Tool-Call-Karten in dieser Ansicht.

### 6. Gemeinsamen Umschalter in der Agent-Detailansicht integrieren

**Datei:**

- `.agents/skills/sssf/apps/visualizer/src/components/AgentDetail.vue`

Ergänze im gemeinsamen Header einen zugänglichen segmentierten Umschalter `Messages | Actions` (Buttons mit eindeutigem Active-State und `aria-pressed` oder äquivalenter Tab-Semantik).

- Beim Öffnen bzw. Wechsel auf einen anderen Agent/Subagent startet die Ansicht in `Messages`.
- In `Messages` wird `AgentMessageFlow` über die volle Inhaltsbreite gerendert.
- In `Actions` bleibt für konfigurierte Agents `ConfiguredAgentDetail` exakt erreichbar; für Subagents bleiben Facts, Turn-Prompt/Result-Karten und `ToolCallRow`-Liste erhalten.
- Das Umschalten darf die Auswahl nicht schließen und keine Action-Daten verändern.
- Beim Wechsel der `agent_id` den Modus und jeden lokalen Zustand zurücksetzen, damit keine Nachrichten des vorherigen Details aufblitzen.

`ConfiguredAgentDetail.vue`, `ToolCallRow.vue` und die bestehenden Activity-/Event-Verträge müssen für diese Trennung nicht umgebaut werden: Die neue Auswahl liegt am gemeinsamen `AgentDetail`-Seam, die heutige Darstellung bleibt der unveränderte Actions-Zweig.

## Tests

### Server-Parser

**Neue Datei:**

- `.agents/skills/sssf/apps/visualizer/server/messages.test.ts`

Nutze realistische Pi-JSONL-Fixtures und decke ab:

1. `message_start`/Deltas/`message_end`/`turn_end` ergeben jeden finalen Text genau einmal.
2. User-, Thinking- und Assistant-Blöcke bleiben über mehrere Tool-Runden und Turns chronologisch.
3. Mehrzeilige Inhalte und Inhalte deutlich über 20.000 Zeichen kommen exakt und ungekürzt zurück.
4. Tool-Calls/-Results, Signaturen, verschlüsselte Felder und Dateipfade gelangen nicht in die Antwort.
5. Fehlerhafte Zeilen und ein unvollständiger Live-Tail werden toleriert.
6. Subagent-Turns werden numerisch (`2` vor `10`) zusammengeführt.
7. Der kompakte Session-Fallback erzeugt denselben sichtbaren Vertrag ohne Raw-/Session-Duplikate.
8. Phasenfilter isolieren zwei Phasen desselben konfigurierten Owners.
9. Missing files sowie lexikalische und Symlink-Pfad-Escapes werden sicher behandelt.

### HTTP-Vertrag

**Datei:**

- `.agents/skills/sssf/apps/visualizer/server/app.test.ts`

Erweitere die vorhandene Unified-Agent-Fixture um echte Raw-Dateien und prüfe:

- konfigurierte und verschachtelte Agents liefern denselben Messages-Vertrag;
- Paging hat keine Lücken oder Duplikate;
- unbekannter/cross-ADW Agent ergibt 404, unsichere IDs oder Cursor ergeben 400;
- ein bekannter Legacy-Agent ohne Dateien liefert 200 mit `available: false`;
- Responses enthalten keine absoluten Fixture-Pfade oder Signaturen.

`server/db.test.ts` braucht nur dann eine Ergänzung, falls die Implementierung wider Erwarten einen kleinen neuen DB-Metadatenzugriff einführt; eine Conversation-Tabelle oder Migration ist ausdrücklich nicht vorgesehen. Die Producer-Tests müssen nicht geändert werden, weil die Raw-/Session-Dateien bereits geschrieben werden und dieses Vorhaben nur liest.

Direkte Vue-Mount-Tests würden neue DOM-/SFC-Testinfrastruktur erfordern, die das Projekt heute nicht besitzt. Halte Toggle- und Polling-Logik deshalb klein, teste Paging/Merge im Client-Modul und verifiziere die tatsächliche Interaktion zusätzlich manuell.

## Verifikation

Im Visualizer-Verzeichnis ausführen:

```bash
cd .agents/skills/sssf/apps/visualizer
bun test
bun run typecheck
bun run lint
bun run build
```

Manuelle Akzeptanz mit einem Lauf, der einen konfigurierten Agent und mindestens einen Subagent mit Tool-Nutzung enthält:

1. Beide Details einzeln öffnen; `Messages` zeigt sofort den vollständigen User-/Thinking-/Assistant-Fluss in chronologischer Reihenfolge.
2. Lange und mehrzeilige Prompts, Reasoning-Texte und Assistant-Antworten bis zum letzten Zeichen vergleichen; keine Tool-Snippets als Ersatz akzeptieren.
3. Während eines laufenden Agents prüfen, dass neu abgeschlossene Nachrichten ohne Duplikate erscheinen.
4. Auf `Actions` wechseln und sicherstellen, dass die bisherige Event-/`log`-/`tool_call`-Ansicht beziehungsweise die Subagent-Turn-/Tools-Ansicht unverändert nutzbar ist.
5. Zwischen Agent und Subagent wechseln und sicherstellen, dass weder Modus- noch Nachrichtenstate des vorherigen Details kurz angezeigt wird.
6. Einen Legacy-Lauf ohne JSONL öffnen; die Nachrichtenansicht zeigt einen erklärenden Leerzustand und `Actions` bleibt nutzbar.

## Nicht Teil der Implementierung

- keine Änderung des Tracer-/SQLite-Schemas;
- keine neue Speicherung oder Duplizierung von Conversation-Daten;
- keine Änderung an `agent_pi.py`, `subagents.ts` oder deren Clipping der weiterhin alternativen Tool-Action-Projektionen;
- keine Darstellung von Tool-Resultaten in der Fließtextansicht, da gefordert sind ausschließlich echte User-, Thinking- und Assistant-Texte und Tools bereits über `Actions` erreichbar bleiben.
