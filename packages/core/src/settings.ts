import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { parse } from "smol-toml";
import { log } from "./log.ts";
import { ParentHarness } from "./parent-harness.ts";
import { agentDir, CONFIG_DIR_NAME } from "./paths.ts";

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

const Args = Schema.Array(Schema.String);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The file's snake_case keys, each with the setting it fills and the type it must have. */
const KEYS: Record<string, readonly [keyof Settings, Schema.Decoder<unknown>]> = {
  close_on_done: ["closeOnDone", Schema.Boolean],
  max_concurrent: ["maxConcurrent", Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))],
  default_timeout_ms: ["defaultTimeoutMs", Count],
  notify: ["notify", Schema.Literals(["follow_up", "passive"])],
  max_depth: ["maxDepth", Count],
  // TOML has no null, so an unset default model is simply absent.
  default_model: ["defaultModel", Schema.String],
  pi_args: ["piArgs", Args],
  claude_args: ["claudeArgs", Args],
};

const parseFile = (path: string): Record<string, unknown> | Error | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
};

/** Unknown keys and wrong types are dropped one by one, the rest of the file still counts. */
const readToml = (path: string): Effect.Effect<Partial<Settings>> =>
  Effect.gen(function* () {
    const parsed = parseFile(path);
    if (!parsed) return {};
    if (parsed instanceof Error) {
      yield* log("settings_parse", { path, error: parsed.message });
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = Object.hasOwn(KEYS, k) ? KEYS[k] : undefined;
      if (key && Schema.is(key[1])(v)) out[key[0]] = v;
      else yield* log("settings_key", { path, key: k, error: "unknown key or wrong type" });
    }
    return out as Partial<Settings>;
  });

/** Global file then project file, later wins. Missing keys fall back to DEFAULTS. */
export const readSettings = (cwd: string, dir: string): Effect.Effect<Settings> =>
  Effect.gen(function* () {
    return {
      ...DEFAULTS,
      ...(yield* readToml(join(dir, FILE))),
      ...(yield* readToml(join(cwd, CONFIG_DIR_NAME, FILE))),
    };
  });

/** Settings as the files say now, for the parent's current cwd. */
export class CurrentSettings extends Context.Service<CurrentSettings, { readonly get: Effect.Effect<Settings> }>()(
  "herdr-agents/CurrentSettings",
) {
  static readonly layer = Layer.effect(
    CurrentSettings,
    Effect.gen(function* () {
      const parent = yield* ParentHarness;
      const dir = yield* agentDir;
      return { get: Effect.suspend(() => readSettings(parent.cwd(), dir)) };
    }).pipe(Effect.orDie),
  );

  /** Fixed settings, for tests. */
  static readonly fixed = (s: Partial<Settings> = {}) =>
    Layer.succeed(CurrentSettings, { get: Effect.succeed({ ...DEFAULTS, ...s }) });
}
