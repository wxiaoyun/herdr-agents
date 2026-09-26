import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FiberMap, Layer, Queue } from "effect";
import { TestClock } from "effect/testing";
import { Compile } from "typebox/compile";
import { type AgentInfo, type HerdrClient, HerdrError } from "../src/herdr.ts";
import { FileLogger, LOG_ENV, log } from "../src/log.ts";
import { childWorkspaceLabel, ENV_PARENT, type SpawnOpts, sameDir } from "../src/manager.ts";
import { BUILTIN_PROFILES, loadProfiles } from "../src/profiles.ts";
import { parseReport } from "../src/session.ts";
import { DEFAULTS, readSettings } from "../src/settings.ts";
import { machineCwd } from "../src/tools.ts";
import { base, deliveries, emptyHerdr, manager, tmp, tools } from "./helpers.ts";

const readReport = (harness: "pi" | "claude", f: string) => parseReport(harness, readFileSync(f, "utf8"));

describe("logging", () => {
  it.effect("is on by default, rotates, truncates long values, and can be redirected or turned off", () =>
    Effect.gen(function* () {
      const agentDir = tmp();
      const path = join(tmp(), "nested", "debug.log");
      const logWith = (env: Record<string, string>, stage: string, fields?: Record<string, unknown>) =>
        log(stage, fields).pipe(
          Effect.provide(
            FileLogger.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PI_CODING_AGENT_DIR: agentDir, ...env }))),
            ),
          ),
        );
      const line = (rest: string) =>
        new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z \\[herdr-agents\\] pid=${process.pid} ${rest}\\n$`);
      const defaultPath = join(agentDir, "herdr-agents-debug.log");

      yield* logWith({ [LOG_ENV]: "0" }, "off");
      expect(existsSync(defaultPath)).toBe(false);

      // On by default, and an oversized file from an earlier run is set aside once.
      writeFileSync(defaultPath, "x".repeat(5 * 1024 * 1024 + 1));
      yield* logWith({}, "default");
      expect(readFileSync(defaultPath, "utf8")).toMatch(line("stage=default "));
      expect(existsSync(`${defaultPath}.1`)).toBe(true);

      yield* logWith({ [LOG_ENV]: path }, "test", { target: "/tmp/example", status: 200, long: "y".repeat(400) });
      expect(readFileSync(path, "utf8")).toMatch(
        line(`stage=test target="/tmp/example" status=200 long="y{299}\\.\\.\\.`),
      );
    }),
  );
});

describe("session", () => {
  it("returns last assistant text and summed usage", () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    const msg = (text: string, cost: number) =>
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { input: 10, output: 5, cost: { total: cost } },
        },
      });
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        msg("first", 0.1),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "x" },
        }),
        "garbage",
        msg("final answer", 0.2),
      ].join("\n"),
    );
    const r = readReport("pi", f);
    expect(r.text).toBe("final answer");
    expect(r.usage).toEqual({
      input: 20,
      output: 10,
      cost: 0.30000000000000004,
      turns: 2,
    });
  });

  const piMsg = (role: string, content: unknown[], extra = {}) =>
    JSON.stringify({
      type: "message",
      message: { role, content, usage: { input: 10, output: 5 }, ...extra },
    });

  it("reports only the latest turn and its stop reason", () => {
    const f = join(tmp(), "s.jsonl");
    writeFileSync(
      f,
      [
        piMsg("user", [{ type: "text", text: "go" }]),
        piMsg("assistant", [{ type: "text", text: "Now let me check..." }], { stopReason: "stop" }),
        piMsg("user", [{ type: "text", text: "continue" }]),
        piMsg("assistant", [{ type: "toolCall" }], { stopReason: "toolUse" }),
        piMsg("toolResult", [{ type: "text", text: "ok" }]),
        piMsg("assistant", [{ type: "thinking", thinking: "plan" }], {
          stopReason: "length",
          provider: "llmbox",
          model: "glm-5.3-flash",
        }),
      ].join("\n"),
    );
    const r = readReport("pi", f);
    expect(r.text).toBe("");
    expect(r.stop).toBe("length");
    expect(r.model).toBe("llmbox/glm-5.3-flash");
    expect(r.usage.turns).toBe(3);
  });

  it.effect("keeps session usage and flags truncation when the turn has no text", () =>
    Effect.gen(function* () {
      const f = join(tmp(), "s.jsonl");
      writeFileSync(
        f,
        piMsg("assistant", [{ type: "thinking", thinking: "plan" }], {
          stopReason: "length",
          model: "glm",
        }),
      );
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentGet: () => Effect.succeed({ status: "idle", pane: "w1:p8", sessionPath: f }),
          agentPromptWait: () => Effect.succeed({ status: "idle", pane: "w1:p8", sessionPath: f }),
        },
      });
      const r = yield* m.spawn(base);
      expect(r.text).toContain("| glm |");
      expect(r.text).toContain("turns=1 in=10 out=5");
      expect(r.text).toContain("stop=length");
      expect(r.text).toContain("truncated at the output limit");
      expect(r.text).not.toContain("screen");
    }),
  );

  it.effect("looks the child workspace up again when herdr no longer has it", () =>
    Effect.gen(function* () {
      const ids = ["w9", "w10"];
      const used: Array<string | undefined> = [];
      const m = yield* manager({
        env: { HERDR_WORKSPACE_ID: "w1" },
        herdr: {
          ...emptyHerdr(),
          workspaceByLabel: () => Effect.succeed(ids.shift()!),
          tabCreate: (_l, cwd, _e, ws) => {
            used.push(ws);
            if (ws === "w9")
              return Effect.fail(new HerdrError({ message: "workspace w9 not found", code: "workspace_not_found" }));
            return Effect.succeed({ pane: "w10:p1", cwd });
          },
        },
      });
      yield* m.spawn(base);
      expect(used).toEqual(["w9", "w10"]);
    }),
  );
});

describe("profiles", () => {
  it.effect("loads project md over builtins", () =>
    Effect.gen(function* () {
      const cwd = tmp();
      const agentDir = tmp();
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agents", "reviewer.md"),
        `---\ndescription: reviews\nmodel: x/y\ntools: read, grep\nallowed_subagents: [Scout]\n---\nBe strict.`,
      );
      writeFileSync(join(cwd, ".pi", "agents", "scout.md"), `---\nname: Scout\ndescription: mine\n---\n`);
      const p = yield* loadProfiles(cwd, agentDir);
      expect(p.get("reviewer")).toMatchObject({
        model: "x/y",
        tools: ["read", "grep"],
        allowedSubagents: ["Scout"],
        systemPrompt: "Be strict.",
        promptMode: "append",
      });
      expect(p.get("Scout")?.description).toBe("mine");
      expect(p.size).toBe(BUILTIN_PROFILES.length + 1);
    }),
  );
});

describe("settings", () => {
  it.effect("merges global < project < defaults", () =>
    Effect.gen(function* () {
      const cwd = tmp();
      const agentDir = tmp();
      writeFileSync(join(agentDir, "herdr-agents.toml"), 'max_concurrent = 2\nmax_depth = 5\ndefault_model = "x/y"\n');
      mkdirSync(join(cwd, ".pi"));
      // A wrong type and an unknown key are dropped, the rest of the file still counts.
      writeFileSync(
        join(cwd, ".pi", "herdr-agents.toml"),
        'max_concurrent = 7\nclaude_args = ["--verbose"]\nmax_depth = "deep"\nmaxDepth = 9\nnope = 1\n',
      );
      expect(yield* readSettings(cwd, agentDir)).toEqual({
        ...DEFAULTS,
        maxConcurrent: 7,
        maxDepth: 5,
        defaultModel: "x/y",
        claudeArgs: ["--verbose"],
      });
    }),
  );
});

describe("live settings", () => {
  it.effect("reads the settings files at each use, so an edit applies without a restart", () =>
    Effect.gen(function* () {
      const dir = tmp();
      mkdirSync(join(dir, ".pi"));
      const write = (toml: string) => writeFileSync(join(dir, ".pi", "herdr-agents.toml"), toml);
      write("max_concurrent = 1\n");
      const m = yield* manager({
        settings: undefined,
        parent: { cwd: () => dir },
        herdr: { ...emptyHerdr(), agentPromptWait: () => Effect.never },
      });
      const opts = { ...base, background: true };
      expect((yield* m.spawn(opts)).status).toBe("running");
      expect((yield* m.spawn(opts)).status).toBe("queued");
      write("max_concurrent = 3\n");
      expect((yield* m.spawn(opts)).status).toBe("running");
      write("max_depth = 0\n");
      expect((yield* Effect.flip(m.spawn(opts))).message).toContain("max nesting depth 0");
    }),
  );
});

describe("profile prompt staging", () => {
  it.effect("passes multi-line prompts as a temp file and cleans it up", () =>
    Effect.gen(function* () {
      let stagedPath: string | undefined;
      let stagedContent: string | undefined;
      let fileAfterStart: boolean | undefined;
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentStart: (_id, _pane, _kind, args) =>
            Effect.sync(() => {
              const i = args.indexOf("--append-system-prompt");
              stagedPath = args[i + 1];
              stagedContent = readFileSync(stagedPath!, "utf8");
              fileAfterStart = existsSync(stagedPath!);
            }),
        },
      });
      yield* m.spawn({
        ...base,
        profile: { name: "t", description: "", promptMode: "append", allowedSubagents: [], systemPrompt: "first line\nsecond line" },
        background: true,
      });
      expect(stagedPath).toBeDefined();
      expect(stagedContent).toBe("first line\nsecond line");
      expect(stagedPath!.includes("\n")).toBe(false);
      expect(fileAfterStart).toBe(true); // readable while pi boots
      expect(existsSync(stagedPath!)).toBe(false); // removed once interactive
    }),
  );

  it.effect("keeps single-line prompts inline", () =>
    Effect.gen(function* () {
      let args: string[] = [];
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentStart: (_id, _pane, _kind, a) =>
            Effect.sync(() => {
              args = a;
            }),
        },
      });
      yield* m.spawn({
        ...base,
        profile: { name: "t", description: "", promptMode: "append", allowedSubagents: [], systemPrompt: "single line" },
        background: true,
      });
      const i = args.indexOf("--append-system-prompt");
      expect(args[i + 1]).toBe("single line");
    }),
  );
});

describe("prompt-wait stall recovery", () => {
  const sessionFile = (dir: string) => {
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, cost: { total: 0 } },
          },
        }),
      ].join("\n"),
    );
    return f;
  };

  const stalled = () =>
    Effect.fail(
      new HerdrError({
        message: "agent prompt produced no observed working or blocked state within 5000 ms; current status is idle",
        code: "agent_prompt_stalled",
      }),
    );

  it.effect("collects the report when the child already finished", () =>
    Effect.gen(function* () {
      const sessionPath = sessionFile(tmp());
      const closed: string[] = [];
      const m = yield* manager({
        settings: { closeOnDone: true },
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: stalled,
          agentGet: () => Effect.succeed({ status: "done", pane: "w1:p8", sessionPath }),
          paneClose: (p) => Effect.sync(() => closed.push(p)),
        },
      });
      const r = yield* m.spawn(base);
      expect(r.status).toBe("closed");
      expect(r.text).toContain("final answer");
      expect(closed).toEqual(["w1:p9"]); // no stranded pane
    }),
  );

  it.effect("does not finish a booting child with no assistant reply yet", () =>
    Effect.gen(function* () {
      const f = join(tmp(), "s.jsonl");
      // Session with only the user prompt: the turn has not produced output.
      writeFileSync(
        f,
        [JSON.stringify({ type: "session" }), JSON.stringify({ type: "message", message: { role: "user" } })].join("\n"),
      );
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: stalled,
          agentGet: () => Effect.succeed({ status: "idle", pane: "w1:p8", sessionPath: f }),
        },
      });
      const spawn = yield* Effect.forkChild(Effect.flip(m.spawn(base)));
      yield* TestClock.adjust("31 seconds");
      const e = yield* Fiber.join(spawn);
      expect(e.message).toMatch(/no observed working[\s\S]*last screen of pi-general-purpose-1:\nscreen/);
      expect(m.list()[0].status).toBe("killed");
    }),
  );

  it.effect("finishes once the assistant reply lands while polling", () =>
    Effect.gen(function* () {
      const f = join(tmp(), "s.jsonl");
      writeFileSync(f, JSON.stringify({ type: "message", message: { role: "user" } }));
      let polls = 0;
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: stalled,
          agentGet: () =>
            Effect.sync(() => {
              polls++;
              if (polls >= 3) {
                // Turn completes mid-poll: assistant message lands in the session.
                writeFileSync(
                  f,
                  JSON.stringify({
                    type: "message",
                    message: { role: "assistant", content: [{ type: "text", text: "late answer" }] },
                  }),
                );
              }
              return { status: "working", pane: "w1:p8", sessionPath: f } as AgentInfo;
            }),
        },
      });
      const spawn = yield* Effect.forkChild(m.spawn(base));
      yield* TestClock.adjust("2 seconds");
      const r = yield* Fiber.join(spawn);
      expect(r.status).toBe("idle");
      expect(r.text).toContain("late answer");
    }),
  );

  it.effect("fails when the stalled child is not in a terminal state", () =>
    Effect.gen(function* () {
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: stalled,
          agentGet: () => Effect.succeed({ status: "working", pane: "w1:p8" }),
        },
      });
      const spawn = yield* Effect.forkChild(Effect.flip(m.spawn(base)));
      yield* TestClock.adjust("31 seconds");
      const e = yield* Fiber.join(spawn);
      expect(e.message).toMatch(/no observed working[\s\S]*last screen of pi-general-purpose-1:\nscreen/);
      expect(m.list()[0].status).toBe("killed");
    }),
  );
});

describe("manager queue", () => {
  it.effect("second background spawn waits for a slot, then starts", () =>
    Effect.gen(function* () {
      let starts = 0;
      // Each herdr wait parks here until the test ends the turn.
      const turns = yield* Queue.unbounded<Deferred.Deferred<AgentInfo>>();
      const secondStart = yield* Deferred.make<void>();
      const turn = () =>
        Effect.gen(function* () {
          const d = yield* Deferred.make<AgentInfo>();
          yield* Queue.offer(turns, d);
          return yield* Deferred.await(d);
        });
      const out = yield* deliveries;
      const m = yield* manager({
        settings: { maxConcurrent: 1 },
        parent: { deliver: out.deliver },
        herdr: {
          ...emptyHerdr(),
          agentStart: () =>
            Effect.suspend(() => (++starts === 2 ? Deferred.succeed(secondStart, undefined) : Effect.void)).pipe(
              Effect.asVoid,
            ),
          agentPromptWait: turn,
          agentWait: turn,
          agentGet: () => Effect.succeed({ status: "idle", pane: "w1:p9" }),
        },
      });
      const opts: SpawnOpts = { ...base, model: "test/model", background: true };
      const a = yield* m.spawn(opts);
      expect(a.status).toBe("running");
      expect(a.text).toContain("model test/model");
      const b = yield* m.spawn(opts);
      expect(b.status).toBe("queued");
      expect(b.text).toContain("model test/model");
      expect(starts).toBe(1);
      yield* Deferred.succeed(yield* Queue.take(turns), { status: "idle", pane: "w1:p9" });
      yield* Deferred.await(secondStart);
      expect(starts).toBe(2);
      expect(m.children.get(a.id)?.status).toBe("idle");
      const sent = yield* out.next;
      expect(sent).toContain(`[subagent ${a.id}`);
      expect(sent).toContain("test/model");
      expect(sent).toContain("screen");
      expect(yield* m.result(a.id, false, 0)).toContain("test/model");
    }),
  );
});

describe("peers", () => {
  it.effect("lists every agent with its relation, resumes an idle peer, never kills one", () =>
    Effect.gen(function* () {
      const f = join(tmp(), "peer.jsonl");
      writeFileSync(
        f,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "peer answer" }] },
        }),
      );
      const box = { id: "abc123", label: "box", target: "me@box", enabled: true };
      const remote: HerdrClient = {
        ...emptyHerdr(),
        agentList: () => Effect.succeed([{ status: "working", pane: "w1:p1", harness: "codex" }]),
        agentGet: () => Effect.succeed({ status: "working", pane: "w1:p1", harness: "codex" }),
      };
      const prompts: string[] = [];
      let childId: string | undefined;
      const m = yield* manager({
        settings: { closeOnDone: true },
        env: { HERDR_PANE_ID: "w1:p1", [ENV_PARENT]: "w1:p2" },
        herdr: {
          ...emptyHerdr(),
          machine: () => remote,
          machineList: () => Effect.succeed([box, { ...box, id: "off", label: "off", enabled: false }]),
          agentList: () =>
            Effect.succeed([
              { status: "working", pane: "w1:p1", harness: "claude" },
              { status: "idle", pane: "w1:p2", harness: "pi" },
              { status: "idle", pane: "w1:p3", name: childId, harness: "pi" },
              { status: "done", pane: "w1:p4", harness: "pi", sessionPath: f },
            ]),
          agentGet: (ref) => Effect.succeed({ status: "idle", pane: ref, harness: "pi", sessionPath: f }),
          agentPromptWait: (ref, text) =>
            Effect.sync(() => {
              prompts.push(`${ref} ${text}`);
              return { status: "idle", pane: ref } as AgentInfo;
            }),
        },
      });
      childId = (yield* m.spawn(base)).id;
      expect((yield* m.agents()).map((a) => `${a.id} ${a.relation} ${a.status}`)).toEqual([
        "w1:p2 parent idle",
        `${childId} child closed`,
        "w1:p4 peer idle",
        "box/w1:p1 peer running",
      ]);
      const r = yield* m.spawn({ ...base, prompt: "review", resume: "w1:p4" });
      expect(r.text).toContain("[peer w1:p4 | pi | idle");
      expect(r.text).toContain("peer answer");
      expect(r.text).not.toContain("KillAgent");
      expect(prompts.at(-1)).toBe("w1:p4 review");
      expect((yield* m.agents()).find((a) => a.id === "w1:p4")?.relation).toBe("peer");
      expect((yield* Effect.flip(m.kill("w1:p4"))).message).toContain("only its parent can kill it");
      expect((yield* Effect.flip(m.spawn({ ...base, resume: "box/w1:p1" }))).message).toContain(
        "only pi and claude peers",
      );
    }),
  );
});

describe("machines and idle children", () => {
  const box = { id: "abc123", label: "box", target: "me@box" };

  it("derives an idempotent child workspace label", () => {
    expect(childWorkspaceLabel("proj")).toBe("proj-agents");
    expect(childWorkspaceLabel("proj-agents")).toBe("proj-agents");
  });

  it.effect("every child gets a tab in the child workspace", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const m = yield* manager({
        env: { HERDR_WORKSPACE_ID: "w1" },
        herdr: {
          ...emptyHerdr(),
          tabCreate: (_l, cwd, _e, ws) =>
            Effect.sync(() => {
              calls.push(`tab ${ws} ${cwd}`);
              return { pane: "w9:p1", cwd };
            }),
        },
      });
      yield* m.spawn(base);
      yield* m.spawn(base);
      expect(calls).toEqual(["tab w9 /", "tab w9 /"]);
    }),
  );

  it.effect("routes every call for a machine child through that machine, none without", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const note = (s: string) => Effect.sync(() => seen.push(s));
      const tagged = (tag: string): HerdrClient => ({
        ...emptyHerdr(),
        machine: (t) => tagged(t.label),
        machineList: () => Effect.succeed([box]),
        tabCreate: (_l, cwd, env) =>
          note(`${tag}:tab parent=${env.HERDR_AGENTS_PARENT}`).pipe(Effect.as({ pane: "w9:p1", cwd })),
        stage: (dir, as) => note(`${tag}:stage ${as === dir ? "same" : as.replace(/-[^-]+$/, "-X")}`),
        agentStart: (_i, _p, _k, args) => note(`${tag}:start mcp=${args.includes("--mcp-config")}`),
        agentPromptWait: () =>
          note(`${tag}:wait`).pipe(Effect.as({ status: "idle", pane: "w9:p1", sessionPath: "/remote/s.jsonl" } as AgentInfo)),
        readFile: (p) =>
          note(`${tag}:read ${p}`).pipe(
            Effect.as(
              JSON.stringify({
                type: "assistant",
                message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi from box" }] },
              }),
            ),
          ),
        paneClose: () => note(`${tag}:close`),
      });
      const m = yield* manager({ env: { HERDR_PANE_ID: "w1:p1" }, herdr: tagged("local") });
      const r = yield* m.spawn({ ...base, machine: "box", harness: "claude" });
      expect(r.text).toContain("hi from box");
      expect(r.text).toContain("| box |");
      expect(m.children.get(r.id)?.machine).toEqual(box);
      expect(r.id).toMatch(/^claude-general-purpose-\d+$/);
      yield* m.kill(r.id);
      yield* m.spawn({ ...base, harness: "claude" });
      expect(seen).toEqual([
        "box:tab parent=",
        "box:stage /tmp/herdr-agents-X",
        "box:start mcp=false",
        "box:wait",
        "box:read /remote/s.jsonl", // settle check
        "box:read /remote/s.jsonl",
        "box:close",
        "local:tab parent=w1:p1",
        "local:stage same",
        "local:start mcp=true",
        "local:wait",
        "local:read /remote/s.jsonl", // settle check
        "local:read /remote/s.jsonl",
      ]);
    }),
  );

  it.effect("rejects an unknown machine before creating anything", () =>
    Effect.gen(function* () {
      let tabs = 0;
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          machineList: () => Effect.succeed([box]),
          tabCreate: () =>
            Effect.sync(() => {
              tabs++;
              return { pane: "w9:p1", cwd: "/" };
            }),
        },
      });
      expect((yield* Effect.flip(m.spawn({ ...base, machine: "nope" }))).message).toContain(
        "unknown machine nope. Saved machines: box",
      );
      expect(tabs).toBe(0);
    }),
  );

  it("maps the parent cwd under home to a remote-home-relative one", () => {
    expect(machineCwd("/Users/me/code/x", "/Users/me")).toBe("code/x");
    expect(machineCwd("/Users/me", "/Users/me")).toBe("~");
    expect(machineCwd("/opt/x", "/Users/me")).toBe("/opt/x");
    expect(sameDir("/home/you/code/x", "code/x")).toBe(true);
    expect(sameDir("/home/you", "code/x")).toBe(false);
    expect(sameDir("/home/you", "~")).toBe(true);
    expect(sameDir("/opt/x/", "/opt/x")).toBe(true);
  });

  it.effect("lists saved machines in the Agent description, none when there are none", () =>
    Effect.gen(function* () {
      const withBox = yield* tools({
        herdr: {
          ...emptyHerdr(),
          machineList: () =>
            Effect.succeed([
              { ...box, label: "box" },
              { ...box, label: "devbox" },
            ]),
        },
      });
      expect(withBox.agent.description).toContain("Saved machines: box, devbox.");
      expect((yield* tools()).agent.description).not.toContain("Saved machines");
    }),
  );

  it.effect("closes the tab and fails when herdr fell back to another cwd", () =>
    Effect.gen(function* () {
      const closed: string[] = [];
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          tabCreate: () => Effect.succeed({ pane: "w9:p1", cwd: "/home/me" }),
          paneClose: (p) => Effect.sync(() => closed.push(p)),
        },
      });
      expect((yield* Effect.flip(m.spawn({ ...base, cwd: "/missing/" }))).message).toContain(
        "cwd /missing/ does not exist on this machine",
      );
      expect(closed).toEqual(["w9:p1"]);
    }),
  );

  it.effect("a machine child that loses its wait goes idle, a local one is killed", () =>
    Effect.gen(function* () {
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          machineList: () => Effect.succeed([box]),
          agentPromptWait: () => Effect.fail(new HerdrError({ message: "bridge gone", code: "ssh_failed" })),
          agentGet: () => Effect.fail(new HerdrError({ message: "unreachable" })),
        },
      });
      expect((yield* Effect.flip(m.spawn({ ...base, machine: "box" }))).message).toContain("bridge gone");
      expect((yield* Effect.flip(m.spawn(base))).message).toContain("bridge gone");
      expect(m.list().map((c) => c.status)).toEqual(["idle", "killed"]);
    }),
  );

  it.effect("a startup dialog pauses the child until a person answers, then the prompt goes in", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const out = yield* deliveries;
      const m = yield* manager({
        parent: { deliver: out.deliver },
        herdr: {
          ...emptyHerdr(),
          agentStart: () => Effect.fail(new HerdrError({ message: "blocked during startup", code: "agent_not_ready" })),
          agentWaitUntil: (_id, states) =>
            Effect.sync(() => {
              seen.push(`wait ${states.join(",")}`);
              return { status: "idle", pane: "w1:p9" } as AgentInfo;
            }),
          agentPromptWait: (_id, text) =>
            Effect.sync(() => {
              seen.push(`prompt ${text}`);
              return { status: "idle", pane: "w1:p9" } as AgentInfo;
            }),
          paneClose: () => Effect.sync(() => seen.push("close")),
        },
      });
      // foreground: the parent keeps waiting while a person answers
      const r = yield* m.spawn(base);
      expect(r.status).toBe("idle");
      expect(seen).toEqual(["wait idle", "prompt go"]);
      expect(out.sent).toHaveLength(0);
      // background: blocked comes back at once, the report is delivered later
      seen.length = 0;
      const b = yield* m.spawn({ ...base, background: true });
      expect(b.status).toBe("blocked");
      expect(b.text).toContain("startup prompt in pane w1:p9");
      expect(b.text).toContain("A person has to answer it");
      yield* out.next;
      expect(seen).toEqual(["wait idle", "prompt go"]);
      expect(m.children.get(b.id)?.status).toBe("idle");
      expect(out.sent).toHaveLength(1);
    }),
  );

  it.effect("keeps the pane after a turn, SendMessage resumes it and delivers the report", () =>
    Effect.gen(function* () {
      const closed: string[] = [];
      const prompts: string[] = [];
      const out = yield* deliveries;
      // The second turn runs until the test lets it end.
      const endTurn = yield* Deferred.make<void>();
      const m = yield* manager({
        parent: { deliver: out.deliver },
        herdr: {
          ...emptyHerdr(),
          paneClose: (p) => Effect.sync(() => closed.push(p)),
          agentPromptWait: (_id, text) =>
            Effect.sync(() => prompts.push(text)).pipe(
              Effect.andThen(text === "go" ? Effect.void : Deferred.await(endTurn)),
              Effect.as({ status: "idle", pane: "w1:p8" } as AgentInfo),
            ),
        },
      });
      const a = yield* m.spawn(base);
      expect(a.status).toBe("idle");
      expect(a.text).toContain("is idle");
      expect(closed).toEqual([]);
      yield* m.send(a.id, "more", "message");
      expect(m.children.get(a.id)?.status).toBe("running");
      yield* Deferred.succeed(endTurn, undefined);
      yield* out.next;
      expect(prompts).toEqual(["go", "more"]);
      expect(m.children.get(a.id)?.status).toBe("idle");
      expect(out.sent).toHaveLength(1);
      yield* m.kill(a.id);
      expect(closed).toEqual(["w1:p9"]);
    }),
  );

  it.effect("holds a Delivery while the parent is busy and drops it once the Report is read", () =>
    Effect.gen(function* () {
      const out = yield* deliveries;
      const m = yield* manager({
        parent: { busy: () => true, deliver: out.deliver },
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: () => Effect.succeed({ status: "idle", pane: "w1:p9" }),
        },
      });
      const read = yield* m.spawn({ ...base, background: true });
      const unread = yield* m.spawn({ ...base, background: true });
      yield* FiberMap.awaitEmpty(m.watchers);
      expect(out.sent).toHaveLength(0);
      yield* m.result(read.id, false, 0);
      yield* m.flush();
      expect(out.sent).toHaveLength(1);
      expect(out.sent[0]).toContain(unread.id);
      yield* m.flush();
      expect(out.sent).toHaveLength(1);
    }),
  );
});

describe("interrupt", () => {
  it.effect("presses esc, waits for the turn to stop, then sends the message", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const note = (s: string) => Effect.sync(() => seen.push(s));
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          sendKeys: (_id, keys) => note(`keys ${keys.join(" ")}`),
          agentWaitUntil: (_id, states) =>
            note(`wait ${states.join(",")}`).pipe(Effect.as({ status: "idle", pane: "w1:p5" } as AgentInfo)),
          agentPrompt: (_id, text) => note(`prompt ${text}`),
        },
      });
      yield* m.send("w1:p5", "stop and do this", "interrupt");
      expect(seen).toEqual(["keys esc", "wait idle,done,blocked", "prompt stop and do this"]);
    }),
  );
});

describe("listing and busy children", () => {
  it.effect("shows the queue place, hides killed children, refuses to resume a busy child", () =>
    Effect.gen(function* () {
      let starts = 0;
      const t = yield* tools({
        settings: { maxConcurrent: 1 },
        herdr: {
          ...emptyHerdr(),
          agentStart: () =>
            Effect.sync(() => {
              starts++;
            }),
          agentPromptWait: () => Effect.never,
        },
      });
      const spawn = (name: string) =>
        t.agent.run({ prompt: "p", description: "d", name, run_in_background: true });
      yield* spawn("a");
      yield* spawn("b");
      yield* spawn("c");
      const listed = (yield* t.list.run({})).text;
      expect(listed).toContain("queued #1/2");
      expect(listed).toContain("queued #2/2");

      const busy = yield* t.agent.run({ prompt: "p", description: "d", resume: "pi-a-1" });
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("kind=interrupt");

      yield* t.kill.run({ agent_id: "pi-c-3" });
      expect((yield* t.list.run({})).text).not.toContain("pi-c-3");
      expect((yield* t.list.run({ status: "killed" })).text).toContain("pi-c-3");
      expect((yield* t.list.run({ relation: "peer" })).text).toBe("no other agents");

      // The killed queued child never launches: the freed slot goes to the next one.
      yield* t.kill.run({ agent_id: "pi-b-2" });
      yield* t.kill.run({ agent_id: "pi-a-1" });
      yield* Effect.yieldNow;
      expect(starts).toBe(1);
      yield* spawn("d");
      expect(starts).toBe(2);
    }),
  );
});

describe("timeouts", () => {
  /** A child whose turns run until the test ends them. `waiting` yields once per herdr wait. */
  const slowTurns = Effect.gen(function* () {
    const turnEnds = yield* Deferred.make<void>();
    const waiting = yield* Queue.unbounded<void>();
    const out = yield* deliveries;
    const turn = () =>
      Queue.offer(waiting, undefined).pipe(
        Effect.andThen(Deferred.await(turnEnds)),
        Effect.as({ status: "idle", pane: "w1:p9" } as AgentInfo),
      );
    const herdr: HerdrClient = { ...emptyHerdr(), agentPromptWait: turn, agentWait: turn };
    return { turnEnds, waiting, out, herdr, end: Deferred.succeed(turnEnds, undefined) };
  });

  it.effect("a foreground timeout detaches: the slot stays taken until the turn ends, then the report arrives", () =>
    Effect.gen(function* () {
      const t = yield* slowTurns;
      const m = yield* manager({ settings: { maxConcurrent: 1 }, parent: { deliver: t.out.deliver }, herdr: t.herdr });
      const spawn = yield* Effect.forkChild(m.spawn({ ...base, timeoutMs: 1000 }));
      yield* Queue.take(t.waiting);
      yield* TestClock.adjust("1 second");
      const r = yield* Fiber.join(spawn);
      expect(r.status).toBe("detached");
      expect(r.text).toContain("timed out after 1000 ms: this is a partial report");
      expect(m.children.get(r.id)?.status).toBe("running");
      // Its slot is still taken, so the next child waits in line.
      const next = yield* m.spawn({ ...base, background: true });
      expect(next.status).toBe("queued");
      yield* m.kill(next.id);
      yield* t.end;
      const report = yield* t.out.next;
      expect(report).toContain(`[subagent ${r.id}`);
      expect(report).not.toContain("partial report");
      expect(m.children.get(r.id)?.status).toBe("idle");
    }),
  );

  it.effect("a background timeout delivers a partial report, then the final one", () =>
    Effect.gen(function* () {
      const t = yield* slowTurns;
      const m = yield* manager({ parent: { deliver: t.out.deliver }, herdr: t.herdr });
      const b = yield* m.spawn({ ...base, background: true, timeoutMs: 1000 });
      yield* Queue.take(t.waiting);
      yield* TestClock.adjust("1 second");
      expect(yield* t.out.next).toContain("partial report");
      expect(m.children.get(b.id)?.status).toBe("running");
      yield* t.end;
      expect(yield* t.out.next).not.toContain("partial report");
      expect(m.children.get(b.id)?.status).toBe("idle");
    }),
  );

  it.effect("a GetAgentResult wait that runs out leaves the Delivery in place", () =>
    Effect.gen(function* () {
      const t = yield* slowTurns;
      const m = yield* manager({ parent: { deliver: t.out.deliver }, herdr: t.herdr });
      const b = yield* m.spawn({ ...base, background: true });
      yield* Queue.take(t.waiting);
      const result = yield* Effect.forkChild(m.result(b.id, true, 1000));
      yield* Queue.take(t.waiting);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(result)).toContain("partial report");
      yield* t.end;
      expect(yield* t.out.next).toContain(`[subagent ${b.id}`);
      expect(m.children.get(b.id)?.status).toBe("idle");
    }),
  );
});

describe("tool schemas", () => {
  it.effect("pi's validator accepts each tool's JSON Schema, and a bad call is an error result", () =>
    Effect.gen(function* () {
      const t = yield* tools();
      for (const tool of t.all) expect(Compile(tool.parameters as any).Check({}), tool.name).toBeTypeOf("boolean");
      const agent = Compile(t.agent.parameters as any);
      expect(agent.Check({ prompt: "p", description: "d", harness: "claude", timeout_ms: 5 })).toBe(true);
      expect(agent.Check({ prompt: "p", description: "d", harness: "codex" })).toBe(false);
      expect(agent.Check({ description: "d" })).toBe(false);
      const bad = yield* t.agent.run({ description: "d" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("Agent: invalid arguments");
      expect(bad.text).toContain("prompt");
    }),
  );
});

describe("failed start", () => {
  it.effect("reports the pane's last screen with the start error", () =>
    Effect.gen(function* () {
      const t = yield* tools({
        herdr: {
          ...emptyHerdr(),
          agentStart: () =>
            Effect.fail(
              new HerdrError({ message: "agent start failed: timed out waiting for agent startup", code: "timeout" }),
            ),
          paneRead: () => Effect.succeed('Error: Model "x/y" not found.'),
        },
      });
      const r = yield* t.agent.run({ prompt: "p", description: "d" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("timed out waiting for agent startup");
      expect(r.text).toContain('Model "x/y" not found');
    }),
  );
});

describe("premature idle", () => {
  it.effect("keeps waiting when herdr says idle mid tool call and working right after", () =>
    Effect.gen(function* () {
      const f = join(tmp(), "s.jsonl");
      const line = (role: string, stopReason: string, text: string) =>
        `${JSON.stringify({ type: "message", message: { role, stopReason, content: [{ type: "text", text }] } })}\n`;
      writeFileSync(f, line("user", "", "go") + line("assistant", "toolUse", ""));
      let waits = 0;
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentPromptWait: () => Effect.succeed({ status: "idle", pane: "w1:p9", sessionPath: f }),
          agentGet: () => Effect.succeed({ status: "working", pane: "w1:p9", sessionPath: f }),
          agentWait: () =>
            Effect.sync(() => {
              waits++;
              writeFileSync(f, line("user", "", "go") + line("assistant", "stop", "really finished"));
              return { status: "idle", pane: "w1:p9", sessionPath: f } as AgentInfo;
            }),
        },
      });
      const spawn = yield* Effect.forkChild(m.spawn(base));
      yield* TestClock.adjust("2 seconds");
      const r = yield* Fiber.join(spawn);
      expect(waits).toBe(1);
      expect(r.text).toContain("really finished");
    }),
  );
});
