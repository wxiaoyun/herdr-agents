/**
 * args.ts: child command line per harness. Multi-line prompts are staged in a
 * file because herdr `agent start` rejects args containing newlines.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./parent-harness.ts";
import type { Profile } from "./profiles.ts";
import type { Settings } from "./settings.ts";

export interface ChildSpec {
  id: string;
  profile: Profile;
  model?: string;
  thinking?: string;
  /** pi: session path. claude: session id. */
  session?: string;
  /** Directory for staged prompt files; omit to force inline prompts. */
  stagedDir?: string;
  /** Where `stagedDir` is visible to the child, when not the same path. */
  stagedAs?: string;
  /** Machine child: this project is not installed there, so no spawn tools. */
  remote?: boolean;
}

export const SPAWN_TOOLS = ["Agent", "GetAgentResult", "KillAgent", "ListAgents"];

/** Claude tool names for the builtin profiles' pi tool names. */
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Bash",
  web_search: "WebSearch",
};

const CLAUDE_EFFORT: Record<string, string> = { off: "low", minimal: "low" };

const CLAUDE_NATIVE_AGENT_TOOLS = ["Agent", "SendMessage", "ListAgents"];

export const MCP_SERVER_PATH = fileURLToPath(
  new URL("../../claude/bin/herdr-agents-mcp.ts", import.meta.url),
);

const mcpConfig = () =>
  JSON.stringify({
    mcpServers: { herdr: { command: "node", args: [MCP_SERVER_PATH] } },
  });

/** Inline when single-line, else a staged file path. */
function promptArg(c: ChildSpec): { file: boolean; value: string } | undefined {
  const value = c.profile.systemPrompt;
  if (!value) return undefined;
  if (c.stagedDir && value.includes("\n")) {
    const file = join(c.stagedDir, "system-prompt.md");
    writeFileSync(file, value, { mode: 0o600 });
    return { file: true, value: join(c.stagedAs ?? c.stagedDir, "system-prompt.md") };
  }
  return { file: false, value };
}

const canSpawn = (p: Profile) =>
  p.allowedSubagents === "all" || p.allowedSubagents.length > 0;

function piArgs(c: ChildSpec, s: Settings): string[] {
  const p = c.profile;
  const args = ["--name", c.id];
  if (c.model) args.push("--model", c.model);
  if (c.thinking) args.push("--thinking", c.thinking);
  const prompt = promptArg(c);
  if (prompt) {
    // pi reads a file path for both flags.
    args.push(
      p.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      prompt.value,
    );
  }
  if (p.tools?.length) {
    args.push(
      "--tools",
      [...p.tools, "SendMessage", ...(canSpawn(p) ? SPAWN_TOOLS : [])].join(","),
    );
  }
  if (c.session) args.push("--session", c.session);
  return [...args, ...s.piArgs];
}

/** pi model ids are `provider/model`. Claude Code runs anthropic models only and wants the bare id. */
export function claudeModel(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  if (model.slice(0, slash) !== "anthropic")
    throw new Error(
      `model ${model}: a Claude Code child can only run anthropic models`,
    );
  return model.slice(slash + 1);
}

/** Claude models without auto mode. A bare alias (`sonnet`, `opus`) is the latest, which has it. */
const NO_AUTO_MODE = /haiku|sonnet-4-[0-5]\b|opus-4-[0-5]\b|claude-3/;

function claudeArgs(c: ChildSpec, s: Settings): string[] {
  const p = c.profile;
  const args = ["--name", c.id];
  if (c.model) args.push("--model", claudeModel(c.model));
  if (c.thinking) args.push("--effort", CLAUDE_EFFORT[c.thinking] ?? c.thinking);
  const prompt = promptArg(c);
  if (prompt) {
    const base = p.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    args.push(prompt.file ? `${base}-file` : base, prompt.value);
  }
  if (p.tools?.length) {
    // --tools restricts Claude's built-in set. Keep the native multi-agent
    // tools for profiles that may spawn at all.
    const tools = p.builtin
      ? p.tools.map((t) => CLAUDE_TOOL_ALIASES[t] ?? t)
      : p.tools;
    if (canSpawn(p)) tools.push(...CLAUDE_NATIVE_AGENT_TOOLS);
    const list = [...new Set(tools)].join(",");
    // A profile that enumerates its tools has approved them: never prompt.
    args.push("--tools", list, "--allowedTools", list);
  }
  // Auto mode lets a classifier approve or deny each action, so the child
  // rarely stops on a prompt. Models without auto mode (Haiku, Sonnet and
  // Opus up to 4.5) fall back to manual, which prompts more than acceptEdits.
  // bypassPermissions shows a startup confirmation that blocks the pane.
  // claudeArgs may override.
  if (!s.claudeArgs.includes("--permission-mode"))
    args.push("--permission-mode", c.model && NO_AUTO_MODE.test(c.model) ? "acceptEdits" : "auto");
  if (!c.remote) args.push("--mcp-config", mcpConfig());
  if (c.session) args.push("--resume", c.session);
  return [...args, ...s.claudeArgs];
}

export function childArgs(harness: Harness, c: ChildSpec, s: Settings): string[] {
  return harness === "claude" ? claudeArgs(c, s) : piArgs(c, s);
}
