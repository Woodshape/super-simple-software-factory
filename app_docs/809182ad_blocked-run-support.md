# Blocked-Run-Unterstützung in SSSF

## Was sich geändert hat

SSSF behandelt einen belegten externen Builder-Blocker jetzt als eigenen, kontrollierten Ausgang statt als Fehler. Nur `BuildOutput` darf `status: "blocked"` melden; `EnvelopeBase` und alle anderen Output-Typen bleiben auf `success | fail` beschränkt.

Der neue Vertrag besteht aus `BlockerEvidence` (`source`, `observation`) und `ExternalBlocker` mit geschlossener Kategorie (`approval`, `access`, `decision`, `external_dependency`, `external_input`), Owner, erforderlicher Aktion, objektiver Resume-Bedingung und mindestens einem Evidence-Eintrag. Felder werden getrimmt und auf Nicht-Leerheit geprüft; unbekannte Felder und ungültige Kategorien werden abgewiesen. `blocked` verlangt einen vollständigen Blocker, während `success` und `fail` keinen Blocker akzeptieren. Der Builder-Prompt verlangt vorherige Repository-/Handoff-Prüfung, sichere Teilarbeit, externe Kontrolle und nicht geheime Evidenz und grenzt interne Arbeits- oder Qualitätsprobleme ausdrücklich aus.

Ein valider Blocked-Report durchläuft weiterhin Parsing, Claim-Gates und Permissions und wird mitsamt Usage, Agent-Map und Handoff persistiert. Der Handoff enthält `status` sowie bei Blockierung den typisierten Blocker. Danach beendet `BlockedRun` (`SystemExit`, Code 2) zentral die Kette: Die Builder-Phase endet erfolgreich, die Session wird `blocked`, Folgephasen werden nicht geöffnet und es gibt keinen Retry, `error`-Event oder Traceback. `Run.finish()` ist idempotent; normale Erfolg-/Fehlerpfade behalten die Exit-Codes 0/1.

Für eine Wiederaufnahme setzt `session_start()` dieselbe `adw_id` wieder auf `running` und leert `ended_at`, ohne Historie, Sequenz oder passende Agent-Session-ID zu verlieren. Ein neuer `Run` übernimmt den alten Blocker nicht als aktiven Zustand. Im Build-Review überspringt ein initialer Blocker den Reviewer; ein blockierter Revisionslauf öffnet keinen weiteren Review. Der Spec-Lifecycle kennt weiterhin nur `planned | in_progress | complete`; Blockierung schreibt keine implizite Completion.

Die Console zeigt den Builder-Bericht neutral/gelb und die Blocker-Kurzzeile (Kategorie, Owner, Aktion, Resume-Bedingung); das Abschluss-Panel lautet `ADW blocked`. Die Observability-Referenz dokumentiert Sessionstatus, Handoff, erwartete Eventfolge und terminale Reconciliation; Phasen behalten bewusst nur `queued | running | success | fail`.

## Träger der Änderung

- Laufzeitvorlagen: `.agents/skills/sssf/templates/adws/adw_modules/{data_types,agents,runner,tracer,console}.py` und `.agents/skills/sssf/templates/adws/adw_build_review.py`.
- Builder-Anleitung: `.agents/skills/sssf/templates/prompt_engineering/builder/user.md`.
- Verhalten und Integrationsgrenzen: `.agents/skills/sssf/references/handoff.md`, `.agents/skills/sssf/references/observability.md` und `specs/809182ad_blocked-run-support.md`.
- Regressionen: `.agents/skills/sssf/templates/adws/tests/test_blocked.py` sowie `.agents/skills/sssf/tests/test_blocked.py`; `.agents/skills/sssf/tests/test_install.py` prüft zusätzlich Neuinstallation, `--force`, Skip lokaler Anpassungen und Template-/installierte `adws/`-Parität. Die neue Skill-Regression stellt außerdem sicher, dass alle 13 Builder-Callsites weiterhin an `BuildOutput` gebunden sind.

## Verifizieren

```sh
uv run .agents/skills/sssf/templates/adws/tests/test_blocked.py
uv run --with pytest --with pydantic --with python-dotenv --with pyyaml --with rich \
  pytest adws/tests .agents/skills/sssf/tests
uv run python -m unittest discover -s adws/tests -p 'test_*.py'
uv run python -m unittest discover -s .agents/skills/sssf/tests -p 'test_*.py'
git diff --check
```

Die Runtime-Suite deckt Schema, Gate-/Permission-Schutz, Persistenz, Observability, Exit-Codes, Resume und Build-Review-Steuerung ab; die Skill- und Installations-Tests prüfen die Synchronität zu den installierten `adws/`-Dateien.
