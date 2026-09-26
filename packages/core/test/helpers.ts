import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer, Queue } from "effect";
import { Herdr, type HerdrClient, HerdrError } from "../src/herdr.ts";
import { Manager } from "../src/manager.ts";
import { ParentHarness, type ParentHarnessShape } from "../src/parent-harness.ts";
import { BUILTIN_PROFILES } from "../src/profiles.ts";
import { CurrentSettings, type Settings } from "../src/settings.ts";
import { makeTools } from "../src/tools.ts";

export const tmp = () => mkdtempSync(join(tmpdir(), "phs-"));

/** Herdr stub with every method a no-op; override per test. */
export const emptyHerdr = (): HerdrClient => ({
  machine() {
    return this;
  },
  machineList: () => Effect.succeed([]),
  readFile: (p) =>
    Effect.try({ try: () => readFileSync(p, "utf8"), catch: (e) => new HerdrError({ message: String(e) }) }),
  stage: () => Effect.void,
  unstage: () => Effect.void,
  tabCreate: (_l, cwd) => Effect.succeed({ pane: "w1:p9", cwd }),
  workspaceLabel: () => Effect.succeed("ws"),
  workspaceByLabel: () => Effect.succeed("w9"),
  agentStart: () => Effect.void,
  agentPrompt: () => Effect.void,
  agentPromptWait: () => Effect.succeed({ status: "done", pane: "w1:p8" }),
  agentWait: () => Effect.succeed({ status: "done", pane: "w1:p8" }),
  agentWaitUntil: () => Effect.succeed({ status: "working", pane: "w1:p8" }),
  agentGet: () => Effect.succeed({ status: "idle", pane: "w1:p8" }),
  agentList: () => Effect.succeed([]),
  agentRead: () => Effect.succeed("screen"),
  paneRead: () => Effect.succeed("pane screen"),
  agentFocus: () => Effect.void,
  sendKeys: () => Effect.void,
  paneRun: () => Effect.void,
  paneReportAgent: () => Effect.void,
  paneClose: () => Effect.void,
});

/** A pi parent that drops Deliveries unless told otherwise. */
export const piParent = (over: Partial<ParentHarnessShape> = {}): ParentHarnessShape => ({
  harness: "pi",
  cwd: () => "/",
  deliver: () => Effect.void,
  setBlocked: () => Effect.void,
  ...over,
});

/** Deliveries in arrival order, plus `next` to wait for the following one. */
export const deliveries = Effect.gen(function* () {
  const q = yield* Queue.unbounded<string>();
  const sent: string[] = [];
  return {
    sent,
    next: Queue.take(q),
    deliver: (text: string) =>
      Effect.sync(() => sent.push(text)).pipe(Effect.andThen(Queue.offer(q, text)), Effect.asVoid),
  };
});

export interface World {
  herdr?: HerdrClient;
  parent?: Partial<ParentHarnessShape>;
  /** Fixed settings. Omit to read the TOML files under the parent's cwd. */
  settings?: Partial<Settings>;
  /** The process env the code sees. PI_CODING_AGENT_DIR defaults to a fresh dir. */
  env?: Record<string, string>;
}

export const layers = (w: World = {}) => {
  const settings: Layer.Layer<CurrentSettings, never, ParentHarness> = w.settings
    ? CurrentSettings.fixed(w.settings)
    : CurrentSettings.layer;
  return settings.pipe(
    Layer.provideMerge(Layer.succeed(ParentHarness, piParent(w.parent))),
    Layer.provideMerge(Layer.succeed(Herdr, w.herdr ?? emptyHerdr())),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ PI_CODING_AGENT_DIR: tmp(), ...w.env }))),
  );
};

export const manager = (w: World = {}) => Manager.make.pipe(Effect.provide(layers({ settings: {}, ...w })));

export const tools = (w: World = {}) => makeTools.pipe(Effect.provide(layers(w)));

export const base = {
  prompt: "go",
  description: "d",
  profile: BUILTIN_PROFILES[0],
  harness: "pi" as const,
  cwd: "/",
  background: false,
  timeoutMs: 0,
  depth: 1,
};
