"""File-backed bridge from nested Pi extensions to the single SQLite tracer writer."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from .data_types import SubagentTraceContext

PROTOCOL = "sssf.subagents.v1"
ENV_NAME = "SSSF_SUBAGENT_CONTEXT"


class TelemetryTail:
    """Incrementally reads complete JSONL records, retaining a partial last line."""

    def __init__(self, context: SubagentTraceContext):
        self.context = context
        self.path = Path(context.telemetry_path)
        # A parent retry gets a fresh tail and must not replay prior sends.
        self.offset = self.path.stat().st_size if self.path.exists() else 0
        self.partial = ""

    def read(self) -> Iterator[dict]:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as stream:
            stream.seek(self.offset)
            chunk = stream.read()
            self.offset = stream.tell()
        if not chunk:
            return
        lines = (self.partial + chunk).split("\n")
        self.partial = lines.pop()
        for line in lines:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if self.valid(record):
                yield record

    def valid(self, record: dict) -> bool:
        return (
            record.get("protocol") == PROTOCOL
            and record.get("adw_id") == self.context.adw_id
            and record.get("phase_id") == self.context.phase_id
            and record.get("parent_agent") == self.context.parent_agent
            and isinstance(record.get("telemetry_id"), str)
            and isinstance(record.get("subagent_id"), str)
            and isinstance(record.get("kind"), str)
        )
