import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { log } from "./log.ts";
import { HARNESSES, type Harness } from "./parent-harness.ts";
import { CONFIG_DIR_NAME, parseFrontmatter } from "./paths.ts";

export interface Profile {
  name: string;
  description: string;
  /** Pin the child harness. Default: the parent's. */
  harness?: Harness;
  model?: string;
  thinking?: string;
  tools?: string[];
  promptMode: "replace" | "append";
  systemPrompt?: string;
  allowedSubagents: "all" | string[];
  /** Builtin profiles name tools in pi terms and get translated per harness. */
  builtin?: true;
}

export const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const BUILTIN_PROFILES: Profile[] = [
  {
    name: "general-purpose",
    builtin: true,
    description:
      "General agent with all tools. Research, multi-step tasks, code changes. Can spawn any subagent.",
    promptMode: "append",
    allowedSubagents: "all",
  },
  {
    name: "Worker",
    builtin: true,
    description:
      "Implementation agent with all tools. Executes a well-specified task end to end. May spawn Scout only.",
    promptMode: "append",
    allowedSubagents: ["Scout"],
  },
  {
    name: "Scout",
    builtin: true,
    description:
      "Read-only fast search agent (read, bash, grep, find, ls, web_search). Locate files, symbols, usages, or web facts. Pick a cheap fast model for it. Cannot spawn subagents.",
    tools: [...READ_ONLY_TOOLS, "web_search"],
    promptMode: "append",
    systemPrompt:
      "You are a read-only scout. Never edit files. Find what was asked, report exact paths, line numbers and short quotes. Be brief.",
    allowedSubagents: [],
  },
];

const asList = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
};

function readProfile(path: string): Profile {
  const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
  const name = String(fm.name ?? basename(path, ".md"));
  const allowed = fm.allowed_subagents;
  return {
    name,
    description: String(fm.description ?? ""),
    harness: HARNESSES.find((h) => h === fm.harness),
    model: fm.model ? String(fm.model) : undefined,
    thinking: fm.thinking ? String(fm.thinking) : undefined,
    tools: asList(fm.tools),
    promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
    systemPrompt: body.trim() || undefined,
    allowedSubagents: allowed === "all" || allowed === undefined ? "all" : (asList(allowed) ?? []),
  };
}

const loadDir = (dir: string, out: Map<string, Profile>): Effect.Effect<void> =>
  Effect.forEach(
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [],
    (f) => {
      const path = join(dir, f);
      return Effect.try(() => readProfile(path)).pipe(
        Effect.tap((p) => Effect.sync(() => out.set(p.name, p))),
        Effect.catch((e) => log("profile_parse", { path, error: String(e.cause) })),
      );
    },
    { discard: true },
  );

/** Builtins first, then global, workspace, project dirs. Same name later wins. */
export const loadProfiles = (cwd: string, agentDir: string): Effect.Effect<Map<string, Profile>> =>
  Effect.gen(function* () {
    const out = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
    yield* loadDir(join(agentDir, "agents"), out);
    yield* loadDir(join(cwd, ".agents", "agents"), out);
    yield* loadDir(join(cwd, CONFIG_DIR_NAME, "agents"), out);
    return out;
  });
