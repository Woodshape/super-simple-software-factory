#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pyyaml"]
# ///
"""Durable spec metadata: parse, resolve, list, and make legal transitions."""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

import yaml
from yaml.nodes import MappingNode, ScalarNode
from yaml.tokens import AliasToken

SpecStatus = Literal["planned", "in_progress", "complete"]
VALID_STATUSES: tuple[SpecStatus, ...] = ("planned", "in_progress", "complete")
NEXT_STATUS: dict[SpecStatus, SpecStatus] = {
    "planned": "in_progress",
    "in_progress": "complete",
}


class SpecMetadataError(ValueError):
    """A spec's metadata, artifact paths, or requested transition is invalid."""


@dataclass(frozen=True)
class SpecDocument:
    status: SpecStatus
    body: bytes


@dataclass(frozen=True)
class PlanArtifacts:
    authoritative: Path
    mirror: Path

    @property
    def paths(self) -> tuple[Path, Path]:
        return self.authoritative, self.mirror


def _line_content(line: bytes) -> bytes:
    if line.endswith(b"\r\n"):
        return line[:-2]
    if line.endswith(b"\n") or line.endswith(b"\r"):
        return line[:-1]
    return line


def parse_bytes(data: bytes, source: str = "<spec>") -> SpecDocument:
    """Parse the required first YAML block while retaining the Markdown body."""
    lines = data.splitlines(keepends=True)
    if not lines or _line_content(lines[0]) != b"---":
        raise SpecMetadataError(f"{source}: first line must be exactly '---'")

    closing = next(
        (index for index, line in enumerate(lines[1:], start=1)
         if _line_content(line) == b"---"),
        None,
    )
    if closing is None:
        raise SpecMetadataError(f"{source}: opening frontmatter has no closing '---'")

    metadata_bytes = b"".join(lines[1:closing])
    try:
        metadata_text = metadata_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SpecMetadataError(f"{source}: frontmatter is not valid UTF-8: {error}") from error

    try:
        if any(isinstance(token, AliasToken) for token in yaml.scan(metadata_text)):
            raise SpecMetadataError(f"{source}: YAML aliases are not allowed")
        node = yaml.compose(metadata_text, Loader=yaml.SafeLoader)
    except SpecMetadataError:
        raise
    except yaml.YAMLError as error:
        problem = getattr(error, "problem", None) or str(error).splitlines()[0]
        raise SpecMetadataError(f"{source}: invalid YAML frontmatter: {problem}") from error

    if node is None:
        raise SpecMetadataError(f"{source}: frontmatter mapping is empty")
    if not isinstance(node, MappingNode):
        raise SpecMetadataError(f"{source}: frontmatter must be a mapping containing only status")

    status_entries = [
        (key, value) for key, value in node.value
        if isinstance(key, ScalarNode) and key.value == "status"
    ]
    if len(status_entries) > 1:
        raise SpecMetadataError(f"{source}: duplicate status key")
    if len(node.value) != 1:
        if not status_entries:
            raise SpecMetadataError(f"{source}: frontmatter must contain exactly one status key")
        raise SpecMetadataError(f"{source}: frontmatter contains keys other than status")

    key, value = node.value[0]
    if not isinstance(key, ScalarNode) or key.value != "status":
        raise SpecMetadataError(f"{source}: frontmatter must contain exactly one status key")
    if key.tag != "tag:yaml.org,2002:str":
        raise SpecMetadataError(f"{source}: status key must be a scalar string")
    if not isinstance(value, ScalarNode) or value.tag != "tag:yaml.org,2002:str":
        raise SpecMetadataError(f"{source}: status must be a scalar string")
    if value.value not in VALID_STATUSES:
        allowed = ", ".join(VALID_STATUSES)
        raise SpecMetadataError(
            f"{source}: unknown status {value.value!r}; expected one of {allowed}")

    return SpecDocument(status=value.value, body=b"".join(lines[closing + 1:]))


def parse(path: str | Path) -> SpecDocument:
    spec_path = Path(path)
    try:
        data = spec_path.read_bytes()
    except OSError as error:
        raise SpecMetadataError(f"{spec_path}: cannot read spec: {error}") from error
    return parse_bytes(data, str(spec_path))


def canonical_bytes(status: SpecStatus, body: bytes) -> bytes:
    if status not in VALID_STATUSES:
        raise SpecMetadataError(f"unknown target status {status!r}")
    return f"---\nstatus: {status}\n---\n".encode() + body


def _atomic_write(path: Path, data: bytes) -> None:
    """Replace one file atomically using a sibling temporary file."""
    path = path.resolve()
    mode = path.stat().st_mode if path.exists() else None
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def transition(paths: Sequence[str | Path], target: str) -> SpecStatus:
    """Apply one legal edge to an authoritative spec and explicit mirrors."""
    if target not in VALID_STATUSES:
        raise SpecMetadataError(
            f"unknown target status {target!r}; expected one of {', '.join(VALID_STATUSES)}")
    if not paths:
        raise SpecMetadataError("at least one explicit spec path is required")

    resolved = [Path(path).resolve() for path in paths]
    if len(set(resolved)) != len(resolved):
        raise SpecMetadataError("spec paths must be unique")

    originals: dict[Path, bytes] = {}
    documents: dict[Path, SpecDocument] = {}
    for path in resolved:
        try:
            originals[path] = path.read_bytes()
        except OSError as error:
            raise SpecMetadataError(f"{path}: cannot read spec: {error}") from error
        documents[path] = parse_bytes(originals[path], str(path))

    authoritative = resolved[0]
    original = originals[authoritative]
    for mirror in resolved[1:]:
        if originals[mirror] != original:
            raise SpecMetadataError(
                f"{mirror}: mirror differs from authoritative spec {authoritative}")

    current = documents[authoritative].status
    expected = NEXT_STATUS.get(current)
    if expected != target:
        expected_note = f"; next legal status is {expected}" if expected else "; complete is terminal"
        raise SpecMetadataError(
            f"illegal spec transition {current} -> {target}{expected_note}")

    replacement = canonical_bytes(target, documents[authoritative].body)
    written: list[Path] = []
    try:
        for path in resolved:
            _atomic_write(path, replacement)
            written.append(path)
    except BaseException as error:
        rollback_errors: list[str] = []
        for path in reversed(written):
            try:
                _atomic_write(path, originals[path])
            except BaseException as rollback_error:
                rollback_errors.append(f"{path}: {rollback_error}")
        suffix = f"; rollback failed for {'; '.join(rollback_errors)}" if rollback_errors else ""
        raise SpecMetadataError(f"spec transition failed: {error}{suffix}") from error

    return target  # type: ignore[return-value]


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _artifact_path(raw: str, repo_root: Path) -> Path:
    path = Path(raw)
    return (path if path.is_absolute() else repo_root / path).resolve()


def resolve_plan_artifacts(envelope, run) -> PlanArtifacts:
    """Resolve exactly one handoff plan and one direct durable spec safely."""
    raw_artifacts = list(envelope.artifacts)
    if len(raw_artifacts) != 2:
        raise SpecMetadataError(
            f"PlanOutput must declare exactly two artifacts, found {len(raw_artifacts)}")

    repo_root = Path(run.repo_root).resolve()
    resolved = [_artifact_path(raw, repo_root) for raw in raw_artifacts]
    if len(set(resolved)) != len(resolved):
        raise SpecMetadataError("PlanOutput artifacts must be unique")
    outside = [path for path in resolved if not _within(path, repo_root)]
    if outside:
        raise SpecMetadataError(f"planner artifact is outside the repository: {outside[0]}")
    missing = [path for path in resolved if not path.is_file()]
    if missing:
        raise SpecMetadataError(f"planner artifact is missing or not a file: {missing[0]}")

    handoff_dir = Path(run.context_handoff_dir)
    if not handoff_dir.is_absolute():
        handoff_dir = repo_root / handoff_dir
    expected_mirror = (handoff_dir / "plan.md").resolve()
    mirrors = [path for path in resolved if path == expected_mirror]
    if len(mirrors) != 1:
        raise SpecMetadataError(
            f"PlanOutput must declare exactly {expected_mirror} as its handoff plan")

    specs_dir = (repo_root / "specs").resolve()
    prefix = f"{run.adw_id}_"
    durable = [
        path for path in resolved
        if path.parent == specs_dir and path.suffix == ".md" and path.name.startswith(prefix)
    ]
    if len(durable) != 1:
        raise SpecMetadataError(
            f"PlanOutput must declare exactly one direct specs/{prefix}*.md artifact")

    return PlanArtifacts(authoritative=durable[0], mirror=mirrors[0])


def validate_plan_artifacts(envelope, run) -> PlanArtifacts:
    artifacts = resolve_plan_artifacts(envelope, run)
    authoritative_bytes = artifacts.authoritative.read_bytes()
    mirror_bytes = artifacts.mirror.read_bytes()
    authoritative = parse_bytes(authoritative_bytes, str(artifacts.authoritative))
    mirror = parse_bytes(mirror_bytes, str(artifacts.mirror))
    if authoritative.status != "planned":
        raise SpecMetadataError(
            f"{artifacts.authoritative}: planner-created spec must have status planned")
    if mirror.status != "planned":
        raise SpecMetadataError(f"{artifacts.mirror}: planner-created mirror must have status planned")
    if authoritative_bytes != mirror_bytes:
        raise SpecMetadataError("planner-created durable spec and handoff plan are not byte-identical")
    return artifacts


def transition_plan(envelope, run, target: str) -> PlanArtifacts:
    artifacts = resolve_plan_artifacts(envelope, run)
    transition(artifacts.paths, target)
    return artifacts


def list_specs(root: str | Path = ".") -> int:
    repo_root = Path(root).resolve()
    specs_dir = repo_root / "specs"
    failed = False
    for path in sorted(specs_dir.glob("*.md"), key=lambda item: item.as_posix()):
        display = path.relative_to(repo_root).as_posix()
        try:
            print(f"{parse(path).status}\t{display}")
        except SpecMetadataError as error:
            reason = str(error).replace("\n", " ")
            print(f"ERROR\t{display}\t{reason}")
            failed = True
    return 1 if failed else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")
    transition_parser = subparsers.add_parser("transition", help="make one legal status transition")
    transition_parser.add_argument("target_status")
    transition_parser.add_argument("authoritative_path")
    transition_parser.add_argument("mirror_paths", nargs="*")
    args = parser.parse_args(argv)

    if args.command is None:
        return list_specs()

    try:
        paths = [args.authoritative_path, *args.mirror_paths]
        result = transition(paths, args.target_status)
        print(f"{result}\t{args.authoritative_path}")
        return 0
    except SpecMetadataError as error:
        print(f"ERROR\t{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
