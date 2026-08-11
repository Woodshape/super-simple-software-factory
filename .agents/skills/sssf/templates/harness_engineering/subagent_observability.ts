import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export const SSSF_SUBAGENT_CONTEXT_ENV = "SSSF_SUBAGENT_CONTEXT";
export const SUBAGENT_PROTOCOL = "sssf.subagents.v1";
const CLIP = 20_000;
const PARENT_RESULT_CHARS = 8_000;

export interface SubagentCompletion {
	id: number;
	turn: number;
	prompt: string;
	elapsedMs: number;
	result: string;
	resultPath?: string;
}

/** Build the bounded parent notification while preserving a route to the full result. */
export function formatSubagentCompletion(completion: SubagentCompletion): string {
	const turnLabel = completion.turn > 1 ? ` (Turn ${completion.turn})` : "";
	const truncated = completion.result.length > PARENT_RESULT_CHARS;
	const preview = completion.result.slice(0, PARENT_RESULT_CHARS);
	const clippingNote = truncated ? "\n\n... [truncated]" : "";
	const resultReference = truncated && completion.resultPath
		? `\n\nFull result: ${completion.resultPath}`
			+ "\nRead that file instead of continuing the subagent to recover truncated text."
		: "";
	return `Subagent #${completion.id}${turnLabel} finished "${completion.prompt}" in ${Math.round(completion.elapsedMs / 1000)}s.`
		+ `\n\nResult:\n${preview}${clippingNote}${resultReference}`;
}

export interface TraceContext {
	version: 1;
	adw_id: string;
	phase_id: string;
	parent_agent: string;
	root: string;
	telemetry_path: string;
}

export interface ChildPaths {
	root: string;
	sessionFile: string;
	turnRaw(turn: number): string;
	turnResult(turn: number): string;
}

function safe(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== ".." ? value : "";
}

export function parseTraceContext(raw = process.env[SSSF_SUBAGENT_CONTEXT_ENV]): TraceContext | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<TraceContext>;
		if (value.version !== 1 || !safe(value.adw_id) || !safe(value.phase_id) || !safe(value.parent_agent)) return null;
		if (!value.root || !value.telemetry_path || !path.isAbsolute(value.root) || !path.isAbsolute(value.telemetry_path)) return null;
		return value as TraceContext;
	} catch {
		return null;
	}
}

export function createSubagentId(displayId: number, now = Date.now()): string {
	return `sub_${now.toString(36)}_${displayId}_${randomBytes(4).toString("hex")}`;
}

export function childPaths(context: TraceContext, subagentId: string): ChildPaths {
	if (!safe(subagentId)) throw new Error("invalid subagent id");
	const root = path.join(context.root, subagentId);
	fs.mkdirSync(root, { recursive: true });
	return {
		root,
		sessionFile: path.join(root, "session.jsonl"),
		turnRaw: (turn) => path.join(root, `turn-${turn}`, "raw_output.jsonl"),
		turnResult: (turn) => path.join(root, `turn-${turn}`, "result.txt"),
	};
}

export class TelemetryWriter {
	private sequence = 0;
	constructor(readonly context: TraceContext) {
		fs.mkdirSync(path.dirname(context.telemetry_path), { recursive: true });
	}

	emit(kind: string, subagentId: string, fields: Record<string, unknown> = {}): string {
		const telemetryId = `${subagentId}:${Date.now().toString(36)}:${++this.sequence}`;
		const record = {
			protocol: SUBAGENT_PROTOCOL,
			telemetry_id: telemetryId,
			kind,
			adw_id: this.context.adw_id,
			phase_id: this.context.phase_id,
			parent_agent: this.context.parent_agent,
			subagent_id: subagentId,
			ts: new Date().toISOString(),
			...fields,
		};
		fs.appendFileSync(this.context.telemetry_path, `${JSON.stringify(record)}\n`);
		return telemetryId;
	}
}

function textOf(value: any): string {
	return (value?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
}

function clip(value: string): string {
	return value.length <= CLIP ? value : `${value.slice(0, CLIP).trimEnd()}…`;
}

/** Fold one child's Pi stream into complete tool activities and final assistant text. */
export class ChildEventTracker {
	private open = new Map<string, { tool: string; args: Record<string, unknown>; startedAt: string; clock: number }>();
	result = "";

	observe(event: any): Record<string, unknown> | null {
		if (event?.type === "message_end") {
			if (event.message?.role === "assistant") {
				const text = textOf(event.message);
				if (text) this.result = text;
			}
			for (const block of event.message?.content ?? []) {
				if (block?.type === "toolCall") this.announce(block.id, block.name, block.arguments);
			}
			return null;
		}
		if (event?.type === "tool_execution_start") {
			this.announce(event.toolCallId, event.toolName, event.args);
			return null;
		}
		if (event?.type !== "tool_execution_end") return null;
		const callId = String(event.toolCallId ?? "");
		const opened = this.open.get(callId);
		this.open.delete(callId);
		const endedAt = new Date().toISOString();
		const args = (event.args ?? opened?.args ?? {}) as Record<string, unknown>;
		return {
			activity_id: callId || `activity_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
			tool_call_id: callId,
			tool: String(event.toolName ?? opened?.tool ?? "tool"),
			args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? clip(value) : value])),
			result_snippet: clip(textOf(event.result ?? {})),
			ok: !event.isError,
			started_at: opened?.startedAt ?? endedAt,
			ended_at: endedAt,
			duration_ms: opened ? Math.max(0, Date.now() - opened.clock) : 0,
		};
	}

	private announce(id: unknown, tool: unknown, args: unknown): void {
		if (!id) return;
		const key = String(id);
		const known = this.open.get(key);
		this.open.set(key, {
			tool: String(tool ?? known?.tool ?? ""),
			args: (args as Record<string, unknown>) ?? known?.args ?? {},
			startedAt: known?.startedAt ?? new Date().toISOString(),
			clock: known?.clock ?? Date.now(),
		});
	}
}

export function appendRaw(file: string, line: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

export function writeResult(file: string, result: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, result);
	fs.renameSync(temporary, file);
}
