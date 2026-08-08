"""The Run object: config + adw_id + agent_map + tracer + console, bound once.

`run.phase(PhaseParams(...))` is the ONE phase primitive — a context manager
for all three kinds (engineer, agent, code). Success must be earned: every
phase defaults to fail; only a clean exit flips it (agent phases additionally
require a parsed envelope + green gates, enforced inside ph.call).
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

from . import agents, git_helper
from .console import Console
from .data_types import (AgentCall, BuildOutput, EnvelopeBase, EventRecord,
                         ExternalBlocker, Phase, PhaseParams)
from .utils import ensure_dir, now_iso


class BlockedRun(SystemExit):
    """Traceback-free control signal for a fully finalized blocked delivery."""

    exit_code = 2

    def __init__(self, blocker: ExternalBlocker):
        self.blocker = blocker
        self.reason = f"{blocker.category}: {blocker.owner} must {blocker.required_action}"
        super().__init__(self.exit_code)


class PhaseHandle:
    def __init__(self, run: Run, phase: Phase):
        self.run = run
        self.phase = phase

    def log(self, **payload) -> None:
        self.run.tracer.event(EventRecord(adw_id=self.run.adw_id,
                                          phase_id=self.phase.phase_id,
                                          type="log", name=self.phase.params.name,
                                          payload=payload))
        self.run.console.note(", ".join(f"{k}: {v}" for k, v in payload.items()))
        if self.phase.params.kind == "engineer" and "input" in payload:
            self.run.tracer.session_request(self.run.adw_id, str(payload["input"]))

    def call(self, call: AgentCall) -> EnvelopeBase:
        if self.phase.params.kind != "agent":
            raise RuntimeError("ph.call() is only valid inside an agent phase")
        envelope = agents.execute(self.run, self.phase, call)
        # Only BuildOutput has the validated blocked contract. Other envelope
        # types cannot stop a chain merely by carrying similarly named fields.
        if isinstance(envelope, BuildOutput) and envelope.blocked:
            blocker = envelope.external_blocker
            assert blocker is not None  # guaranteed by BuildOutput's validator
            self.run.register_blocker(blocker)
            raise BlockedRun(blocker)
        return envelope


class Run:
    def __init__(self, cfg, adw_id: str, tracer, engineer: str):
        self.cfg = cfg
        self.adw_id = adw_id
        self.tracer = tracer
        self.console = Console(tracer, adw_id)
        self.engineer = engineer
        self.phases: list[Phase] = []
        self.tokens = 0
        self.cost = 0.0
        self.external_blocker: ExternalBlocker | None = None
        self._finished_exit_code: int | None = None
        self._seq = tracer.max_phase_seq(adw_id)   # a joined run continues the sequence
        self.repo_root = git_helper.repo_root()    # where every agent is spawned to work
        self.session_dir = ensure_dir(Path(cfg.defaults.data_dir) / "sessions" / adw_id)
        self.context_handoff_dir = ensure_dir(self.session_dir / "context_handoff")
        self._agent_map_path = self.session_dir / "agent_map.json"
        self.agent_map: dict = (json.loads(self._agent_map_path.read_text())
                                if self._agent_map_path.exists() else {})

    # ── agent map (adw_id -> per-agent coding-agent session ids) ────────────
    def save_agent_map(self, agent: str, entry: dict) -> None:
        self.agent_map[agent] = entry
        self._agent_map_path.write_text(json.dumps(self.agent_map, indent=2))

    # ── usage (run totals mirror what the tracer accumulates in sqlite) ─────
    def add_usage(self, tokens: int, cost: float) -> None:
        self.tokens += tokens
        self.cost += cost
        self.tracer.session_add_usage(self.adw_id, tokens, cost)

    def register_blocker(self, blocker: ExternalBlocker) -> None:
        """Hold only this execution attempt's validated blocker in memory."""
        self.external_blocker = blocker

    # ── the phase primitive ─────────────────────────────────────────────────
    @contextmanager
    def phase(self, params: PhaseParams):
        self._seq += 1
        phase = Phase(phase_id=f"{self.adw_id}_{self._seq:02d}_{params.name}",
                      adw_id=self.adw_id, seq=self._seq, params=params,
                      status="running", started_at=now_iso())
        self.phases.append(phase)
        self.tracer.phase_upsert(phase)
        self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                      type="phase_start", name=params.name,
                                      payload={"kind": params.kind, "owner": params.owner,
                                               "description": params.description}))
        self.console.phase_started(phase)
        clock = time.monotonic()
        try:
            yield PhaseHandle(self, phase)
        except BlockedRun as blocked:
            # Agent execution, schema validation, gates, permissions, envelope
            # persistence and handoff all passed. The delivery is blocked, but
            # this phase therefore succeeded.
            phase.status = "success"
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "success"}))
            self.tracer.phase_upsert(phase)
            self.console.phase_ended(phase, time.monotonic() - clock)
            self.finish(blocked=True, reason=blocked.reason)
            raise
        except BaseException as error:
            phase.status = "fail"                      # success must be earned
            phase.error = str(error)[:1000]
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="error", name=params.name,
                                          payload={"error": phase.error}))
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "fail"}))
            self.tracer.phase_upsert(phase)
            self.tracer.session_finish(self.adw_id, ok=False)
            self.console.phase_ended(phase, time.monotonic() - clock)
            self.console.session_finished("fail", self.tokens, self.cost,
                                          self.cfg.observability.db)
            raise
        else:
            phase.status = "success"
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "success"}))
            self.tracer.phase_upsert(phase)
            self.console.phase_ended(phase, time.monotonic() - clock)

    # ── run outcome ─────────────────────────────────────────────────────────
    def finish(self, accepted: bool = True, reason: str = "", blocked: bool = False) -> int:
        """Finalize once and return 0/1/2 for success/fail/blocked.

        Every current phase must have passed. A registered external blocker then
        takes precedence over a negative acceptance result, because acceptance
        was never reached; failed phases still take precedence over blocking.
        """
        if self._finished_exit_code is not None:
            return self._finished_exit_code

        phases_ok = bool(self.phases) and all(p.status == "success" for p in self.phases)
        has_blocker = self.external_blocker is not None
        if phases_ok and has_blocker:
            status, code = "blocked", BlockedRun.exit_code
        elif phases_ok and accepted and not blocked:
            status, code = "success", 0
        else:
            status, code = "fail", 1
            if phases_ok and not accepted:
                note = reason or "the run's acceptance criterion was not met"
                self.tracer.event(EventRecord(
                    adw_id=self.adw_id,
                    phase_id=self.phases[-1].phase_id if self.phases else "",
                    type="error", name="not_accepted", payload={"reason": note}))
                self.console.note(f"not accepted: {note}")
            elif blocked and not has_blocker:
                self.console.note("blocked finalization requested without a validated external blocker")

        self.tracer.session_finish(self.adw_id, status=status)
        self.console.session_finished(status, self.tokens, self.cost,
                                      self.cfg.observability.db)
        self._finished_exit_code = code
        return code
