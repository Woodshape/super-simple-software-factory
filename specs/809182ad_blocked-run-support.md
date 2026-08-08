---
status: planned
---

# Plan: Blocked-Run-Unterstützung aus `kios-mvp` übernehmen

## Ziel und Integrationsregel

Die Blocked-Run-Semantik aus `../kios-mvp` Commit `41fd31d` wird hunkweise auf den aktuellen SSSF-Stand übertragen. Der Commit darf nicht als Ganzes übernommen und kein SSSF-/Visualizer-Verzeichnis pauschal kopiert werden, weil er Kios-Produktänderungen, eine Kios-spezifische `shared/WORKLOG.md`-Freigabe und einen älteren Visualizer-Stand enthält.

Verbindliche Ergebnisse:

| Fall | Builder-Envelope | Builder-Phase | Session | Prozesscode | Spec-Lifecycle |
|---|---|---|---|---:|---|
| geliefert | `success`, ohne Blocker | `success` | `success` nach Acceptance | `0` | nur explizite grüne Completion-Phase |
| extern blockiert | `blocked` plus validierter `ExternalBlocker` | `success` | `blocked` | `2` | unverändert `planned`/`in_progress` |
| Ausführung, Gate, Permission oder Acceptance fehlgeschlagen | `fail`/Exception/negative Acceptance | bisherige Semantik | `fail` | `1` | keine implizite Completion |

`blocked` ist nur ein Builder-Ausgang für eine belegte, extern kontrollierte Voraussetzung. Rote Tests, Implementierungs- oder Reviewfehler, fehlende lokale Recherche, Unsicherheit, Aufwand oder Kontextdruck bleiben normale Arbeit beziehungsweise `fail`.

## Zu ändernde Dateien

Distributable und installierte Dateien sind jeweils bytegleich zu halten:

- `.agents/skills/sssf/templates/adws/adw_modules/data_types.py` ↔ `adws/adw_modules/data_types.py`
- `.agents/skills/sssf/templates/adws/adw_modules/agents.py` ↔ `adws/adw_modules/agents.py`
- `.agents/skills/sssf/templates/adws/adw_modules/runner.py` ↔ `adws/adw_modules/runner.py`
- `.agents/skills/sssf/templates/adws/adw_modules/tracer.py` ↔ `adws/adw_modules/tracer.py`
- `.agents/skills/sssf/templates/adws/adw_modules/console.py` ↔ `adws/adw_modules/console.py`
- `.agents/skills/sssf/templates/adws/adw_build_review.py` ↔ `adws/adw_build_review.py`
- `.agents/skills/sssf/templates/prompt_engineering/builder/user.md` ↔ `adws/adw_data/prompt_engineering/builder/user.md`
- neue `.agents/skills/sssf/templates/adws/tests/test_blocked.py` ↔ neue `adws/tests/test_blocked.py`

Nur in der Skill-Quelle:

- `.agents/skills/sssf/references/handoff.md`
- `.agents/skills/sssf/references/observability.md`
- neue `.agents/skills/sssf/tests/test_blocked.py`
- `.agents/skills/sssf/tests/test_install.py`

## 1. Typisierten Evidence-Vertrag ergänzen

In beiden `adw_modules/data_types.py`:

- `BlockerEvidence` als Pydantic-Modell mit `extra="forbid"` und nicht leeren, getrimmten Feldern `source` und `observation` ergänzen. Der Vertrag und Prompt verbieten Secrets/Credentials; die Struktur validiert nicht-leere Evidenz und keine unbekannten Felder.
- `ExternalBlocker` mit geschlossener Kategorie `approval | access | decision | external_dependency | external_input`, nicht leeren Feldern `owner`, `required_action`, `resume_when` und mindestens einem `BlockerEvidence`-Eintrag ergänzen; ebenfalls unbekannte Felder verbieten.
- Nur `BuildOutput.status` auf `success | fail | blocked` erweitern. `EnvelopeBase` und alle anderen Output-Typen bleiben strikt bei `success | fail`.
- `external_blocker: ExternalBlocker | None = None`, einen read-only `blocked`-Prädikator und einen Model-Validator ergänzen: `blocked` verlangt den vollständigen Blocker; `success` und `fail` verbieten ihn.
- Bestehende Success-/Fail-Payloads ohne das neue Feld, bestehende Defaults und sämtliche bestehenden Callsite-Typbindungen rückwärtskompatibel lassen.

In beiden Builder-`user.md`:

- Die Output-Triad synchronisieren: normales Success-/Fail-Beispiel mit `external_blocker: null` sowie ein vollständiges Blocked-Beispiel mit Kategorie, Owner, Aktion, objektiver Resume-Bedingung und Evidence-Liste dokumentieren.
- Vor `blocked` verpflichtend Repo/Handoff/relevante Commands prüfen, sichere Teilarbeit ausschöpfen oder deren Unmöglichkeit konkret begründen, externe Kontrolle belegen sowie Aktion, Resume-Kriterium und mindestens eine nicht geheime Evidenz nennen lassen.
- Die unzulässigen internen Blockadegründe ausdrücklich nennen und verlangen, dass ein gültiger Blocker als typisiertes JSON mit `status: "blocked"` statt als Freitext oder `fail` gemeldet wird.
- Alle derzeit 13 `output_type=BuildOutput`-Callsites je installiertem und Template-ADW inventarisieren, aber nicht auf Sondertypen oder per-Workflow-Blockerzweige umstellen.

## 2. Agentenpfad sicher und beobachtbar halten

In beiden `adw_modules/agents.py` ausschließlich den Abschluss von `execute()` erweitern:

- Einen schema-validen Blocked-Report durch dieselben JSON-Parsing-, Claim-Gate- und Permission-Schritte wie Success laufen lassen. Gates und `permissions.enforce()` bleiben unverändert streng und laufen vor der Akzeptanz/Persistenz; ein Blocker darf weder falsche `changed_files` noch unerlaubte Writes kaschieren.
- Nach erfolgreicher Prüfung weiterhin Envelope, Usage, Agent-Session und `agent_map.json` persistieren.
- Das bestehende `handoff`-Payload additiv um `status` und nur bei vorhandenem Blocker um dessen `model_dump()` erweitern; danach wie bisher `agent_end` und Console-Abschluss schreiben.
- Nur `status == "fail"` in den bisherigen Runtime-Fehler umwandeln. Der validierte Blocked-`BuildOutput` wird an `PhaseHandle` zurückgegeben.
- Die neueren Tool-Message-/Tool-Activity-Hooks unangetastet lassen: insbesondere `_event_forwarder()`, `agent_pi.ToolCallTracker`, `tool_call_id`, `tracer.link_subagent_parent()` und die aktuellen Tool-Event-Payloads nicht durch Kios-Dateikopien überschreiben.

## 3. Blocked-Ausgang zentral im Runner finalisieren

In beiden `adw_modules/runner.py`:

- `BlockedRun(SystemExit)` mit stabilem Code `2`, dem validierten `ExternalBlocker` und einer kompakten Reason ergänzen. Dadurch endet ein nicht abgefangener CLI-Lauf ohne Python-Traceback.
- `PhaseHandle.call()` ausschließlich bei einem validierten, blockierten `BuildOutput` den Blocker am aktuellen `Run` registrieren und `BlockedRun` auslösen lassen. Andere Envelopes können die Kette nicht durch ähnlich benannte Felder stoppen.
- Pro neuem `Run` nur einen frischen In-Memory-Blocker und einen Cache für den bereits finalisierten Exitcode halten; historische DB-Daten dürfen nicht automatisch als aktiver Blocker rehydriert werden.
- Im Phase-Context `BlockedRun` vor dem allgemeinen `BaseException`-Zweig behandeln: Builder-Phase mit Endzeit und normalem `phase_end(status=success)` erfolgreich abschließen, Console-Phase schließen, die Session einmal blockiert finalisieren und das Signal weiterreichen. Kein `error`-Event und kein roter Phasenabschluss.
- `Run.finish()` idempotent auf `0/1/2` erweitern. Fehlgeschlagene Phasen bleiben `fail`; bei vollständig erfolgreichen aktuellen Phasen gewinnt ein registrierter externer Blocker vor einer noch nicht erreichbaren Acceptance. Ein Blocker erzeugt kein `not_accepted`-Event. Bestehende Success-, Exception- und negative-Acceptance-Pfade behalten Codes und Events.
- Durch den zentralen Abbruch keine nachfolgenden Test-, Review-, Commit-, Dokumentations- oder `spec_complete`-Phasen öffnen; keine redundante Blocked-Abfrage in allen ADWs einbauen.

## 4. Trace, Resume und Console erweitern

In beiden `adw_modules/tracer.py`:

- `session_finish()` rückwärtskompatibel sowohl mit den bestehenden booleschen Aufrufen als auch mit explizitem Terminalstatus `success | fail | blocked` machen und ungültige Statuswerte ablehnen.
- Die bestehende terminale Reconciliation vollständig bewahren: vor dem Sessionabschluss laufende Phasen, Prozesse, Nested Turns und Subagents beenden/reconciliieren. Die neueren Subagent-Tabellen, Ingestion-Methoden und Parent-Link-Logik nicht ersetzen.
- Bei `session_start()` einer vorhandenen `adw_id` den Aggregatstatus auf `running` setzen und `ended_at` leeren, aber historische Phasen, Events, Envelopes, Usage und Agent-Sessions behalten. Sequenznummer und passende Pi-Session-ID laufen wie bisher weiter.

In beiden `adw_modules/console.py`:

- `session_finished()` kompatibel zu booleschen Altaufrufen halten und zusätzlich `blocked` akzeptieren. Success bleibt grün, Fail rot, Blocked erhält gelbes `ADW blocked`-Panel, Warn-Level, korrekte Passed-Zahl und den bestehenden Trace-Hinweis.
- Einen blockierten `BuildOutput` gelb/neutral als erfolgreich validierten Agentenbericht darstellen und eine geclippte Blockerzeile mit Kategorie, Owner, Aktion und Resume-Bedingung ausgeben; Evidence-Inhalte beziehungsweise Secrets nicht zusätzlich in die Console spiegeln.
- Alle neuen Zeilen weiter ausschließlich über `_emit()` ausgeben, damit Console und `log`-Events identisch bleiben. Die Phase selbst behält den grünen Success-Abschluss.

## 5. Build-Review und Spec-Lifecycle korrekt stoppen

In beiden `adw_build_review.py`:

- Den bisherigen Workflow in eine interne Funktion ziehen und am äußeren `main()` ausschließlich den bereits finalisierten `BlockedRun` in Rückgabecode `2` übersetzen.
- Initial blockiert: keinen Reviewer starten. Nach einem Review blockierte `revise_N`: vor `review_(N+1)` stoppen. Der bestehende bounded Review-/Revision-Loop bleibt für normale Ablehnung unverändert und endet weiterhin mit Code `1`, wenn nie genehmigt wird.
- Docstring entsprechend präzisieren; Blocked nicht als Review-Rejection, Commit oder Acceptance behandeln.

Für alle spec-führenden ADWs gilt ohne zusätzliche Callsite-Änderung:

- Blocked nach `spec_start` lässt die Spec `in_progress`; ein Standalone-/Build-Review-Lauf verändert eine vorhandene `planned`- oder `in_progress`-Spec nicht.
- Es gibt keinen Spec-Status `blocked`; nur ein tatsächlich erreichter grüner `spec_complete`-Pfad darf `complete` schreiben.

## 6. Referenzen aktualisieren

In `.agents/skills/sssf/references/handoff.md`:

- Den BuildOutput-spezifischen Status, beide Evidence-Modelle, Invarianten, Guardrails und Rückwärtskompatibilität dokumentieren.
- Festhalten, dass ein valider Blocker beim ersten Parseversuch akzeptiert wird, aber Gates und Permissions vollständig bestehen muss; ungültige Kombinationen bleiben normale JSON-Validierungsfehler.
- Persistenzreihenfolge, `BlockedRun`, Phase-/Sessionstatus, Code `2`, ausbleibende Folgephasen und sichere Wiederaufnahme derselben Agent-Session erklären.
- Die Unabhängigkeit des Spec-Lifecycles ausdrücklich auch für blockierte Sessions dokumentieren.

In `.agents/skills/sssf/references/observability.md`:

- `sessions.status` um `blocked` erweitern; `phases.status` bewusst unverändert lassen.
- Das Handoff-Payload mit `status`/`external_blocker`, die erwartete Eventfolge und das Fehlen von Retry, invalid envelope, `error` und Traceback dokumentieren.
- Terminale Reconciliation, Console-Darstellung, Codes `0/1/2` und Resume (`running`, `ended_at=NULL`, Historie und Session-ID erhalten, kein aktiver alter Blocker) festhalten.
- Bestehende Beschreibungen der neueren Tool-Call- und Nested-Agent-Observability unverändert bewahren.

## 7. Regressionen und Installationsparität

Neue, bytegleiche Runtime-Tests in `.agents/skills/sssf/templates/adws/tests/test_blocked.py` und `adws/tests/test_blocked.py` aus dem Kios-Test ableiten und an den aktuellen Stand anpassen:

- Schema: Legacy-Success/-Fail; vollständiger typisierter Blocker; Ablehnung fehlender/leerer/zusätzlicher/ungültiger Felder; kein Blocked für andere Envelope-Typen.
- Runtime: genau ein gemockter Pi-Send und Attempt 1; Gate und Permission jeweils ausgeführt; Envelope, Handoff mit Blocker, Agent-Map, Usage, `agent_end`, erfolgreiche Phase und blocked Session persistiert; keine Retry-/Error-/Traceback-Ausgabe und keine laufenden Prozesse/Phasen nach Abschluss.
- Negativpfade: GateFailure und PermissionBreach bleiben rote Fehler trotz Blocker; Success `0`, Exception/Fail/negative Acceptance `1` bleiben unverändert.
- Resume: dieselbe `adw_id` wird wieder `running`, `ended_at` wird geleert, Sequenz und unveränderte Agent-Session-ID werden fortgesetzt, alter Blocker bleibt nur historische Evidenz und ein späterer Lauf kann `success` erreichen.
- Workflow: initialer Blocker überspringt Review; blockierte Revision überspringt weiteren Review; genehmigter und ausgeschöpft abgelehnter Normalpfad behalten `0`/`1`; geplante/in-progress Specs bleiben bytegleich und `spec_complete` wird nicht geöffnet.

Neue `.agents/skills/sssf/tests/test_blocked.py`:

- Den Template-Runtime-Test als echten `uv run` ausführen.
- Für alle oben gelisteten blockiertheitsbezogenen Template-/Installed-Paare Byteparität prüfen und die unveränderte Anzahl/Bindung aller Builder-Callsites kontrollieren.
- Den aus Kios stammenden Maintenance-Roster-Test und die Erwartung `shared/WORKLOG.md` nicht übernehmen; die Maintenance-Konfiguration ist nicht Teil dieser Funktion.

`.agents/skills/sssf/tests/test_install.py`:

- Die bestehende Installationsregression um die Blocked-Runtime-Module, `adw_build_review.py`, Builder-Prompt und `adws/tests/test_blocked.py` erweitern.
- Neuinstallation und `--force` müssen exakt aus Templates stampen; eine normale Installation muss lokale Anpassungen weiterhin überspringen. Dafür ist keine neue Installer-Logik nötig, weil `.agents/skills/sssf/scripts/install.py` bereits rekursiv `templates/adws` und den Builder-Prompt stampft.

Nicht aus Commit `41fd31d` übernehmen:

- die Änderung an `.agents/skills/sssf/tests/test_specs.py` (nur Kios-Repositorystatus-/Lifecycle-Migration, keine Blocked-Runtime-Semantik),
- `shared/WORKLOG.md` oder dessen Write-Freigabe in `sssf.maintenance.config.yaml`,
- Änderungen unter `backend/`, `frontend/`, `shared/` oder an Kios-Specs.

## 8. Neuere Zieländerungen ausdrücklich bewahren

- Keine Datei unter `.agents/skills/sssf/apps/visualizer/` ändern oder aus `kios-mvp` kopieren. Insbesondere `server/messages.ts`, Message-/Tool-Flow-Tests, `shared/types.ts`, `AgentMessageFlow.vue` und die vollständige Agent-Message-/Tool-Activity-Darstellung aus den aktuellen Commits `59278e7` und `3f2bb31` bleiben erhalten.
- In überlappenden SSSF-Dateien nur die Blocked-Hunks integrieren. Aktuelle Tool-Call-Weiterleitung in `agents.py`, Parent-Verknüpfung und Nested-Agent-Reconciliation in `tracer.py` bleiben bestehen.
- `.agents/skills/sssf/scripts/install.py`, `.agents/skills/sssf/references/config.md`, `.agents/skills/sssf/templates/sssf.maintenance.config.yaml`, `justfile`, `agent_pi.py`, `permissions.py`, Gates und Quality-Module nicht durch Kios-Versionen ersetzen. Der aktuelle Maintenance-Roster bleibt eng auf SSSF-Pfade begrenzt und erhält keine Kios-Referenz.

## Verifikation

Alle Befehle nach Exitstatus beurteilen:

1. Direkte Blocked-Runtime-Regressionssuite: `uv run .agents/skills/sssf/templates/adws/tests/test_blocked.py`.
2. Vollständige Python-Abdeckung inklusive bestehender pytest-Tests: `uv run --with pytest --with pydantic --with python-dotenv --with pyyaml --with rich pytest adws/tests .agents/skills/sssf/tests`.
3. Zusätzlich die beiden unittest-Discover-Pfade aus dem bestehenden SSSF-Workflow ausführen:
   - `uv run python -m unittest discover -s adws/tests -p 'test_*.py'`
   - `uv run python -m unittest discover -s .agents/skills/sssf/tests -p 'test_*.py'`
4. Die neuen Paritätstests beziehungsweise `cmp -s` für jedes gelistete Template-/Installed-Paar ausführen; Neuinstallation, Skip und `--force` werden durch `test_install.py` abgedeckt.
5. Den unveränderten Success-Pfad gemäß Modul-Cookbook mit `uv run adws/adw_prompt.py "ping"` rauchtesten.
6. Die neueren Visualizer-Funktionen unverändert grün bestätigen: in `.agents/skills/sssf/apps/visualizer` `bun test` und `bun run typecheck` ausführen, ohne generierte Visualizer-Artefakte zu übernehmen.
7. `git diff --check` ausführen. Abschließend mit `git status --short` und `git diff --name-only` sicherstellen, dass ausschließlich die geplanten SSSF-Dateien betroffen sind, kein Visualizer-/Kios-Produktcode verändert wurde und keine `shared/WORKLOG.md`-Referenz in die distributable oder installierte Maintenance-Konfiguration gelangt ist.
