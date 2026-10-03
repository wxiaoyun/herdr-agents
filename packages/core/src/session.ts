import { join } from "node:path";
import type { Harness } from "./parent-harness.ts";

export interface Report {
  /** Last assistant text of the latest turn, empty when that turn has none. */
  text: string;
  /** Input counts cached tokens too. Cost is absent when the harness has not recorded it. */
  usage: { input: number; output: number; cost?: number; turns: number };
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
 * provider, model, usage:{input,output,cacheRead,cacheWrite,cost:{total}}}}`.
 * A user message starts a new turn, so text from an earlier turn never stands
 * in for the latest one.
 */
function readPi(raw: string): Report {
  const r = EMPTY();
  for (const e of entries(raw)) {
    const m = e?.message;
    if (e?.type !== "message") continue;
    if (m?.role === "user") r.text = "";
    if (m?.role !== "assistant") continue;
    r.usage.turns++;
    r.usage.input += (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0);
    r.usage.output += m.usage?.output ?? 0;
    r.usage.cost = (r.usage.cost ?? 0) + (m.usage?.cost?.total ?? 0);
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
 * Claude Code: `{type:"assistant", message:{id, role, content, usage:{input_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens, output_tokens}}}`.
 * One API response is split over several entries sharing `message.id`, so
 * usage is counted once per id. Cost is only in a `{type:"cost-state",
 * totalCostUSD}` entry, the session total Claude writes when it exits, so a
 * session with a turn after it has no known cost. The format is internal to
 * Claude Code; on any surprise this yields no text and the caller falls back
 * to the screen.
 */
function readClaude(raw: string): Report {
  const r = EMPTY();
  r.usage.cost = undefined;
  const seen = new Set<string>();
  for (const e of entries(raw)) {
    const m = e?.message;
    if (e?.type === "cost-state" && typeof e.totalCostUSD === "number") r.usage.cost = e.totalCostUSD;
    if (e?.type === "user" && isPrompt(m)) r.text = "";
    if (e?.type !== "assistant" || m?.role !== "assistant") continue;
    r.stop = m.stop_reason ?? r.stop;
    if (m.model) r.model = m.model;
    const id = String(m.id ?? r.usage.turns);
    if (!seen.has(id)) {
      seen.add(id);
      r.usage.turns++;
      r.usage.cost = undefined;
      const u = m.usage;
      r.usage.input += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
      r.usage.output += u?.output_tokens ?? 0;
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

/**
 * Claude Code's project dir name for a cwd: every non-alphanumeric char is a
 * dash, and a name over 200 chars is cut there plus a hash of the cwd.
 */
// ponytail: the hash is copied from Claude Code 2.1.288. If it changes, long
// cwds miss the session file and the report falls back to the screen; list
// `projects/` for the 200-char prefix, as Claude itself does, if that bites.
function claudeProject(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/**
 * Claude Code keeps sessions at `<config dir>/projects/<encoded cwd>/<id>.jsonl`
 * and herdr only reports the id. pi reports the path itself. On a Machine the
 * config dir is unknown, so the caller passes `~/.claude` for ssh to expand.
 */
export function sessionPathFor(
  harness: Harness,
  cwd: string,
  sessionId: string | undefined,
  claudeDir: string,
): string | undefined {
  if (harness !== "claude" || !sessionId) return undefined;
  return join(claudeDir, "projects", claudeProject(cwd), `${sessionId}.jsonl`);
}

export const formatUsage = (u: Report["usage"]): string =>
  `turns=${u.turns} in=${u.input} out=${u.output}${u.cost === undefined ? "" : ` cost=$${u.cost.toFixed(4)}`}`;

/** Usage plus the stop reason, for a Report header. */
export const formatStats = (r: Report): string =>
  `${formatUsage(r.usage)}${r.stop ? ` stop=${r.stop}` : ""}`;
