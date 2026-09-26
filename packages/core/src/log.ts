/**
 * log.ts: one line per step to a file, never to the TUI streams. On by
 * default: a failure is only debuggable if the log already exists when it
 * happens. `HERDR_AGENTS_LOG=0` turns it off, a file path redirects it.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Config, Effect, Layer, Logger, References } from "effect";
import { agentDir } from "./paths.ts";

export const LOG_ENV = "HERDR_AGENTS_LOG";
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Log a named step. `fields` become searchable `key=value` pairs. */
export const log = (stage: string, fields: Record<string, unknown> = {}): Effect.Effect<void> =>
  Effect.logInfo(stage).pipe(Effect.annotateLogs(fields));

const format = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .map(([k, v]) => {
      const j = JSON.stringify(v) ?? "undefined";
      return `${k}=${j.length > 300 ? `${j.slice(0, 300)}...` : j}`;
    })
    .join(" ");

const fileLogger = (path: string) =>
  Logger.make(({ message, fiber, date }) => {
    const stage = Array.isArray(message) ? message.join(" ") : String(message);
    const fields = fiber.getRef(References.CurrentLogAnnotations);
    try {
      appendFileSync(
        path,
        `${date.toISOString()} [herdr-agents] pid=${process.pid} stage=${stage} ${format(fields)}\n`,
      );
    } catch {
      // Logging must never write to the TUI streams or break extension behavior.
    }
  });

/** Create the log dir and set an oversized file from an earlier run aside. */
const prepare = (path: string): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // ponytail: size is checked once per process and one old file is kept;
    // a process that logs over the cap in one run grows past it.
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // A broken log dir must not stop the tools.
  }
};

/**
 * Replaces every logger (the default one writes to the console, which would
 * corrupt the TUI and the MCP stdout). Resolves the path once.
 */
export const FileLogger: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Config.String(LOG_ENV).pipe(Config.withDefault("1"));
    if (configured === "0") return Logger.layer([]);
    const path = configured === "1" ? join(yield* agentDir, "herdr-agents-debug.log") : configured;
    prepare(path);
    return Logger.layer([fileLogger(path)]);
  }).pipe(Effect.orDie),
);

/** Log from outside any runtime, e.g. before a parent harness has one. */
export const logNow = (stage: string, fields: Record<string, unknown> = {}): void =>
  Effect.runSync(log(stage, fields).pipe(Effect.provide(FileLogger)));
