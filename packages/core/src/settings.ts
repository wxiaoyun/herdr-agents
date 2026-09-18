import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { log } from "./herdr.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "./paths.ts";

export interface Settings {
  closeOnDone: boolean;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  notify: "follow_up" | "passive";
  maxDepth: number;
  defaultModel: string | null;
  /** Extra CLI args appended to every child pi. */
  piArgs: string[];
  /** Extra CLI args appended to every child Claude Code. */
  claudeArgs: string[];
}

export const DEFAULTS: Settings = {
  closeOnDone: false,
  maxConcurrent: 4,
  defaultTimeoutMs: 0,
  notify: "follow_up",
  maxDepth: 2,
  defaultModel: null,
  piArgs: [],
  claudeArgs: [],
};

const FILE = "herdr-agents.toml";

const camel = (key: string): string => key.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** Keys are snake_case in the file, e.g. `max_concurrent`. Unknown keys and wrong types are dropped. */
function readToml(path: string): Partial<Settings> {
  if (!existsSync(path)) return {};
  try {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parse(readFileSync(path, "utf8")))) {
      const key = camel(k) as keyof Settings;
      const want = DEFAULTS[key];
      // `default_model` has no default to take a type from: TOML has no null.
      const okType =
        key === "defaultModel"
          ? typeof v === "string"
          : key in DEFAULTS && typeof v === typeof want && Array.isArray(v) === Array.isArray(want);
      // `maxDepth` would survive `camel` unchanged: the file format is snake_case only.
      if (okType && /^[a-z_]+$/.test(k)) out[key] = v;
      else log("settings_key", { path, key: k, error: "unknown key or wrong type" });
    }
    return out;
  } catch (e) {
    log("settings_parse", { path, error: String(e) });
    return {};
  }
}

/** Global file then project file, later wins. Missing keys fall back to DEFAULTS. */
export function loadSettings(cwd: string, agentDir = getAgentDir()): Settings {
  return {
    ...DEFAULTS,
    ...readToml(join(agentDir, FILE)),
    ...readToml(join(cwd, CONFIG_DIR_NAME, FILE)),
  };
}
