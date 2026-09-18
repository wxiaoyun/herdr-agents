import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./herdr.ts";
import type { Harness } from "./parent-harness.ts";

export interface Report {
  /** Last assistant text of the latest turn, empty when that turn has none. */
  text: string;
  usage: { input: number; output: number; cost: number; turns: number };
  /** Stop reason of the last assistant message, in the harness's own words. */
  stop?: string;
  /** Error the harness recorded on the last assistant message. */
  error?: string;
  /** Model that produced the last assistant message. */
  model?: string;
}

/** Stop reasons of a turn that finished normally, pi and Claude Code. */
const NORMAL_STOPS = new Set(["stop", "end_turn", "stop_sequence"]);
export const abnormalStop = (r: Report | undefined): boolean =>
  !!r?.stop && !NORMAL_STOPS.has(r.stop);

const EMPTY = (): Report => ({
  text: "",
  usage: { input: 0, output: 0, cost: 0, turns: 0 },
});

function readLocal(sessionPath: string): string {
  try {
    return readFileSync(sessionPath, "utf8");
  } catch (e) {
    log("read_session", { sessionPath, error: String(e) });
    return "";
  }
}

function entries(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip partial or garbage lines
    }
  }
  return out;
}

const textOf = (m: any): string =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

/**
 * pi: `{type:"message", message:{role, content, stopReason, errorMessage,
 * provider, model, usage:{input,output,cost:{total}}}}`. A user message starts
 * a new turn, so text from an earlier turn never stands in for the latest one.
 */
function readPi(raw: string): Report {
  const r = EMPTY();
  for (const e of entries(raw)) {
    const m = e?.message;
    if (e?.type !== "message") continue;
    if (m?.role === "user") r.text = "";
    if (m?.role !== "assistant") continue;
    r.usage.turns++;
    r.usage.input += m.usage?.input ?? 0;
    r.usage.output += m.usage?.output ?? 0;
    r.usage.cost += m.usage?.cost?.total ?? 0;
    r.stop = m.stopReason;
    r.error = m.errorMessage;
    if (m.model) r.model = m.provider ? `${m.provider}/${m.model}` : m.model;
    const t = textOf(m);
    if (t.trim()) r.text = t;
  }
  return r;
}

/** A Claude Code user entry typed as a prompt, not one carrying tool results. */
const isPrompt = (m: any): boolean =>
  typeof m?.content === "string" ||
  (Array.isArray(m?.content) && m.content.some((c: any) => c.type !== "tool_result"));

/**
 * Claude Code: `{type:"assistant", message:{id, role, content, usage:{input_tokens,output_tokens}}}`.
 * One API response is split over several entries sharing `message.id`, so
 * usage is counted once per id. The format is internal to Claude Code; on
 * any surprise this yields no text and the caller falls back to the screen.
 */
function readClaude(raw: string): Report {
  const r = EMPTY();
  const seen = new Set<string>();
  for (const e of entries(raw)) {
    const m = e?.message;
    if (e?.type === "user" && isPrompt(m)) r.text = "";
    if (e?.type !== "assistant" || m?.role !== "assistant") continue;
    r.stop = m.stop_reason ?? r.stop;
    if (m.model) r.model = m.model;
    const id = String(m.id ?? r.usage.turns);
    if (!seen.has(id)) {
      seen.add(id);
      r.usage.turns++;
      r.usage.input += m.usage?.input_tokens ?? 0;
      r.usage.output += m.usage?.output_tokens ?? 0;
    }
    const t = textOf(m);
    if (t.trim()) r.text = t;
  }
  return r;
}

/** Last assistant message text plus summed usage from session file contents. */
export function parseReport(harness: Harness, raw: string): Report {
  return harness === "claude" ? readClaude(raw) : readPi(raw);
}

/** `parseReport` over a local session file. */
export const readReport = (harness: Harness, sessionPath: string): Report =>
  parseReport(harness, readLocal(sessionPath));

/**
 * Role of the last message entry, or undefined when the file has no messages
 * yet (missing file, boot in progress, garbage only). An assistant entry that
 * stopped for a tool call is still mid-turn and counts as the user's.
 */
export function parseLastSpeaker(
  harness: Harness,
  raw: string,
): string | undefined {
  let last: string | undefined;
  for (const e of entries(raw)) {
    const isMsg =
      harness === "claude"
        ? e?.type === "user" || e?.type === "assistant"
        : e?.type === "message";
    if (!isMsg || !e.message?.role) continue;
    last =
      e.message.stop_reason === "tool_use" || e.message.stopReason === "toolUse"
        ? "user"
        : e.message.role;
  }
  return last;
}

/** `parseLastSpeaker` over a local session file. */
export const lastSpeaker = (
  harness: Harness,
  sessionPath: string,
): string | undefined => parseLastSpeaker(harness, readLocal(sessionPath));

/**
 * Claude Code keeps sessions at `<config dir>/projects/<encoded cwd>/<id>.jsonl`
 * and herdr only reports the id. pi reports the path itself. On a Machine the
 * config dir is unknown, so the path starts with `~/.claude` for ssh to expand.
 */
export function sessionPathFor(
  harness: Harness,
  cwd: string,
  sessionId: string | undefined,
  remote = false,
): string | undefined {
  if (harness !== "claude" || !sessionId) return undefined;
  const dir = remote
    ? "~/.claude"
    : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  return join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

export const formatUsage = (u: Report["usage"]): string =>
  `turns=${u.turns} in=${u.input} out=${u.output} cost=$${u.cost.toFixed(4)}`;

/** Usage plus the stop reason, for a Report header. */
export const formatStats = (r: Report): string =>
  `${formatUsage(r.usage)}${r.stop ? ` stop=${r.stop}` : ""}`;
