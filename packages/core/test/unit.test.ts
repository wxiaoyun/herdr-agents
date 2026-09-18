import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Herdr, HerdrError, LOG_ENV, log } from "../src/herdr.ts";
import { childWorkspaceLabel, ENV_PARENT, Manager, type SpawnOpts, sameDir } from "../src/manager.ts";
import type { ParentHarness } from "../src/parent-harness.ts";
import { BUILTIN_PROFILES, loadProfiles } from "../src/profiles.ts";
import { readReport } from "../src/session.ts";
import { DEFAULTS, loadSettings } from "../src/settings.ts";
import { createTools, machineCwd } from "../src/tools.ts";

/** Minimal parent harness stub so background watchers can deliver without throwing. */
const piStub = (): ParentHarness => ({
  harness: "pi",
  deliver: () => {},
  setBlocked: () => {},
});

const tmp = () => mkdtempSync(join(tmpdir(), "phs-"));

/** Herdr stub with every method as a no-op; override per test. */
const emptyHerdr = (): Herdr => ({
  tabCreate: async (_l, cwd) => ({ pane: "w1:p9", cwd }),
  machine() {
    return this;
  },
  machineList: async () => [],
  machineLabels: () => [],
  readFile: async (p) => readFileSync(p, "utf8"),
  stage: async () => {},
  unstage: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
  agentStart: async () => {},
  agentPrompt: async () => {},
  agentPromptWait: async () => ({ status: "done", pane: "w1:p8" }),
  agentWait: async () => ({ status: "done", pane: "w1:p8" }),
  agentWaitUntil: async () => ({ status: "working", pane: "w1:p8" }),
  agentGet: async () => ({ status: "idle", pane: "w1:p8" }),
  agentList: async () => [],
  agentRead: async () => "screen",
  agentFocus: async () => {},
  sendKeys: async () => {},
  paneRun: async () => {},
  paneReportAgent: async () => {},
  paneClose: async () => {},
});

describe("logging", () => {
  it("writes to the default or configured file", () => {
    const agentDir = tmp();
    const path = join(tmp(), "nested", "debug.log");
    const previousLog = process.env[LOG_ENV];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      process.env[LOG_ENV] = "1";
      log("default");
      expect(
        readFileSync(join(agentDir, "herdr-agents-debug.log"), "utf8"),
      ).toBe("[herdr-agents] stage=default \n");

      process.env[LOG_ENV] = path;
      log("test", { target: "/tmp/example", status: 200 });
      expect(readFileSync(path, "utf8")).toBe(
        '[herdr-agents] stage=test target="/tmp/example" status=200\n',
      );
    } finally {
      if (previousLog === undefined) delete process.env[LOG_ENV];
      else process.env[LOG_ENV] = previousLog;
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
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

  it("keeps session usage and flags truncation when the turn has no text", async () => {
    const f = join(tmp(), "s.jsonl");
    writeFileSync(
      f,
      piMsg("assistant", [{ type: "thinking", thinking: "plan" }], {
        stopReason: "length",
        model: "glm",
      }),
    );
    const fake: Herdr = {
      ...emptyHerdr(),
      agentGet: async () => ({ status: "idle", pane: "w1:p8", sessionPath: f }),
      agentPromptWait: async () => ({ status: "idle", pane: "w1:p8", sessionPath: f }),
    };
    const m = new Manager(piStub(), DEFAULTS, fake);
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.text).toContain("| glm |");
    expect(r.text).toContain("turns=1 in=10 out=5");
    expect(r.text).toContain("stop=length");
    expect(r.text).toContain("truncated at the output limit");
    expect(r.text).not.toContain("screen");
  });

  it("looks the child workspace up again when herdr no longer has it", async () => {
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "w1";
    const ids = ["w9", "w10"];
    const used: Array<string | undefined> = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      workspaceByLabel: async () => ids.shift()!,
      tabCreate: async (_l, cwd, _e, ws) => {
        used.push(ws);
        if (ws === "w9") throw new HerdrError("workspace w9 not found", "workspace_not_found");
        return { pane: "w10:p1", cwd };
      },
    };
    try {
      const m = new Manager(piStub(), DEFAULTS, fake);
      await m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "pi",
        cwd: "/",
        background: false,
        timeoutMs: 0,
        depth: 1,
      });
      expect(used).toEqual(["w9", "w10"]);
    } finally {
      if (prev === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = prev;
    }
  });
});

describe("profiles", () => {
  it("loads project md over builtins", () => {
    const cwd = tmp();
    const agentDir = tmp();
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "reviewer.md"),
      `---\ndescription: reviews\nmodel: x/y\ntools: read, grep\nallowed_subagents: [Scout]\n---\nBe strict.`,
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "scout.md"),
      `---\nname: Scout\ndescription: mine\n---\n`,
    );
    const p = loadProfiles(cwd, agentDir);
    expect(p.get("reviewer")).toMatchObject({
      model: "x/y",
      tools: ["read", "grep"],
      allowedSubagents: ["Scout"],
      systemPrompt: "Be strict.",
      promptMode: "append",
    });
    expect(p.get("Scout")?.description).toBe("mine");
    expect(p.size).toBe(BUILTIN_PROFILES.length + 1);
  });
});

describe("settings", () => {
  it("merges global < project < defaults", () => {
    const cwd = tmp();
    const agentDir = tmp();
    writeFileSync(
      join(agentDir, "herdr-agents.json"),
      JSON.stringify({ maxConcurrent: 2, maxDepth: 5 }),
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "herdr-agents.json"),
      JSON.stringify({ maxConcurrent: 7, claudeArgs: ["--verbose"] }),
    );
    expect(loadSettings(cwd, agentDir)).toEqual({
      ...DEFAULTS,
      maxConcurrent: 7,
      maxDepth: 5,
      claudeArgs: ["--verbose"],
    });
  });
});

describe("profile prompt staging", () => {
  it("passes multi-line prompts as a temp file and cleans it up", async () => {
    let stagedPath: string | undefined;
    let stagedContent: string | undefined;
    let fileAfterStart: boolean | undefined;
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async (_id, _pane, _kind, args) => {
        const i = args.indexOf("--append-system-prompt");
        stagedPath = args[i + 1];
        stagedContent = readFileSync(stagedPath!, "utf8");
        fileAfterStart = existsSync(stagedPath!);
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await m.spawn({
      prompt: "go",
      description: "d",
      profile: {
        name: "t",
        description: "",
        promptMode: "append",
        allowedSubagents: [],
        systemPrompt: "first line\nsecond line",
      },
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    });
    expect(stagedPath).toBeDefined();
    expect(stagedContent).toBe("first line\nsecond line");
    expect(stagedPath!.includes("\n")).toBe(false);
    expect(fileAfterStart).toBe(true); // readable while pi boots
    expect(existsSync(stagedPath!)).toBe(false); // removed once interactive
  });

  it("keeps single-line prompts inline", async () => {
    let args: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async (_id, _pane, _kind, a) => {
        args = a;
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await m.spawn({
      prompt: "go",
      description: "d",
      profile: {
        name: "t",
        description: "",
        promptMode: "append",
        allowedSubagents: [],
        systemPrompt: "single line",
      },
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    });
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toBe("single line");
  });
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

  const stallErr = () =>
    new HerdrError(
      "agent prompt produced no observed working or blocked state within 5000 ms; current status is idle",
      "agent_prompt_stalled",
    );

  it("collects the report when the child already finished", async () => {
    const dir = tmp();
    const sessionPath = sessionFile(dir);
    const closed: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "done",
        pane: "w1:p8",
        sessionPath,
      }),
      paneClose: async (p) => {
        closed.push(p);
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS, closeOnDone: true }, fake);
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.status).toBe("done");
    expect(r.text).toContain("final answer");
    expect(closed).toEqual(["w1:p9"]); // no stranded pane
  });

  it("does not finish a booting child with no assistant reply yet", async () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    // Session with only the user prompt: the turn has not produced output.
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        JSON.stringify({ type: "message", message: { role: "user" } }),
      ].join("\n"),
    );
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "idle",
        pane: "w1:p8",
        sessionPath: f,
      }),
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 300; // keep the test fast
    await expect(
      m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "pi",
        cwd: "/",
        background: false,
        timeoutMs: 0,
        depth: 1,
      }),
    ).rejects.toThrow(/no observed working[\s\S]*last screen of pi-general-purpose-1:\nscreen/);
    expect(m.children.get([...m.children.keys()][0])?.status).toBe("killed");
  });

  it("finishes once the assistant reply lands while polling", async () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ type: "message", message: { role: "user" } }),
    );
    let polls = 0;
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => {
        polls++;
        if (polls >= 3) {
          // Turn completes mid-poll: assistant message lands in the session.
          writeFileSync(
            f,
            JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "late answer" }],
              },
            }),
          );
        }
        return { status: "working", pane: "w1:p8", sessionPath: f };
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 3000;
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.status).toBe("idle");
    expect(r.text).toContain("late answer");
  });

  it("fails when the stalled child is not in a terminal state", async () => {
    const fake: Herdr = {
      ...emptyHerdr(),
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "working",
        pane: "w1:p8",
        sessionPath: undefined,
      }),
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 300; // keep the test fast
    await expect(
      m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "pi",
        cwd: "/",
        background: false,
        timeoutMs: 0,
        depth: 1,
      }),
    ).rejects.toThrow(/no observed working[\s\S]*last screen of pi-general-purpose-1:\nscreen/);
    expect(m.children.get([...m.children.keys()][0])?.status).toBe("killed");
  });
});

describe("manager queue", () => {
  it("second background spawn waits for a slot, then starts", async () => {
    let starts = 0;
    let waiters: Array<(v: any) => void> = [];
    const fake: Herdr = {
      tabCreate: async (_l, cwd) => ({ pane: "w1:p9", cwd }),
  machine() {
    return this;
  },
  machineList: async () => [],
  machineLabels: () => [],
  readFile: async (p) => readFileSync(p, "utf8"),
  stage: async () => {},
  unstage: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {
        starts++;
      },
      agentPrompt: async () => {},
      agentPromptWait: () => new Promise((r) => waiters.push(r)),
      agentWait: () => new Promise((r) => waiters.push(r)),
      agentWaitUntil: async () => ({ status: "working", pane: "w1:p9" }),
      agentGet: async () => ({
        status: "idle",
        pane: "w1:p9",
        sessionPath: undefined,
      }),
      agentList: async () => [],
      agentRead: async () => "screen",
      agentFocus: async () => {},
      sendKeys: async () => {},
      paneRun: async () => {},
      paneReportAgent: async () => {},
      paneClose: async () => {},
    };
    const sent: string[] = [];
    const pHarness: ParentHarness = {
      ...piStub(),
      deliver: (t: string) => {
        sent.push(t);
      },
    };
    const m = new Manager(pHarness, { ...DEFAULTS, maxConcurrent: 1 }, fake);
    const base: SpawnOpts = {
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      model: "test/model",
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    };
    const a = await m.spawn(base);
    expect(a.status).toBe("running");
    expect(a.text).toContain("model test/model");
    const b = await m.spawn(base);
    expect(b.status).toBe("queued");
    expect(b.text).toContain("model test/model");
    expect(starts).toBe(1);
    waiters.shift()!({ status: "idle", pane: "w1:p9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(2);
    expect(m.children.get(a.id)?.status).toBe("idle");
    expect(sent[0]).toContain(`[subagent ${a.id}`);
    expect(sent[0]).toContain("test/model");
    expect(sent[0]).toContain("screen");
    expect(await m.result(a.id, false, 0)).toContain("test/model");
  });
});

describe("peers", () => {
  it("lists every agent with its relation, resumes an idle peer, never kills one", async () => {
    const f = join(tmp(), "peer.jsonl");
    writeFileSync(
      f,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "peer answer" }] },
      }),
    );
    const box = { id: "abc123", label: "box", target: "me@box", enabled: true };
    const remote: Herdr = {
      ...emptyHerdr(),
      agentList: async () => [{ status: "working", pane: "w1:p1", harness: "codex" }],
      agentGet: async () => ({ status: "working", pane: "w1:p1", harness: "codex" }),
    };
    const prompts: string[] = [];
    let childId: string | undefined;
    const fake: Herdr = {
      ...emptyHerdr(),
      machine: () => remote,
      machineList: async () => [box, { ...box, id: "off", label: "off", enabled: false }],
      agentList: async () => [
        { status: "working", pane: "w1:p1", harness: "claude" },
        { status: "idle", pane: "w1:p2", harness: "pi" },
        { status: "idle", pane: "w1:p3", name: childId, harness: "pi" },
        { status: "idle", pane: "w1:p4", harness: "pi", sessionPath: f },
      ],
      agentGet: async (ref) => ({ status: "idle", pane: ref, harness: "pi", sessionPath: f }),
      agentPromptWait: async (ref, text) => {
        prompts.push(`${ref} ${text}`);
        return { status: "idle", pane: ref };
      },
    };
    const env = { HERDR_PANE_ID: process.env.HERDR_PANE_ID, [ENV_PARENT]: process.env[ENV_PARENT] };
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env[ENV_PARENT] = "w1:p2";
    try {
      const m = new Manager(piStub(), { ...DEFAULTS, closeOnDone: true }, fake);
      const base = { prompt: "go", description: "d", profile: BUILTIN_PROFILES[0], harness: "pi" as const, cwd: "/", background: false, timeoutMs: 0, depth: 1 };
      childId = (await m.spawn(base)).id;
      expect((await m.agents()).map((a) => `${a.id} ${a.relation}`)).toEqual([
        "w1:p2 parent",
        `${childId} child`,
        "w1:p4 peer",
        "box/w1:p1 peer",
      ]);
      const r = await m.spawn({ ...base, prompt: "review", resume: "w1:p4" });
      expect(r.text).toContain("[peer w1:p4 | pi | idle");
      expect(r.text).toContain("peer answer");
      expect(r.text).not.toContain("KillAgent");
      expect(prompts.at(-1)).toBe("w1:p4 review");
      expect((await m.agents()).find((a) => a.id === "w1:p4")?.relation).toBe("peer");
      await expect(m.kill("w1:p4")).rejects.toThrow("only its parent can kill it");
      await expect(m.spawn({ ...base, resume: "box/w1:p1" })).rejects.toThrow("only pi and claude peers");
    } finally {
      for (const [k, v] of Object.entries(env))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});

describe("machines and idle children", () => {
  const base: SpawnOpts = {
    prompt: "go",
    description: "d",
    profile: BUILTIN_PROFILES[0],
    harness: "pi",
    cwd: "/",
    background: false,
    timeoutMs: 0,
    depth: 1,
  };
  const box = { id: "abc123", label: "box", target: "me@box" };

  it("derives an idempotent child workspace label", () => {
    expect(childWorkspaceLabel("proj")).toBe("proj-agents");
    expect(childWorkspaceLabel("proj-agents")).toBe("proj-agents");
  });

  it("every child gets a tab in the child workspace", async () => {
    const calls: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      tabCreate: async (_l, cwd, _e, ws) => {
        calls.push(`tab ${ws} ${cwd}`);
        return { pane: "w9:p1", cwd };
      },
    };
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "w1";
    try {
      const m = new Manager(piStub(), { ...DEFAULTS }, fake);
      await m.spawn(base);
      await m.spawn(base);
    } finally {
      if (prev === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = prev;
    }
    expect(calls).toEqual(["tab w9 /", "tab w9 /"]);
  });

  it("routes every call for a machine child through that machine, none without", async () => {
    const seen: string[] = [];
    const tagged = (tag: string): Herdr => ({
      ...emptyHerdr(),
      machine: (t) => tagged(t.label),
      machineList: async () => [box],
      tabCreate: async (_l, cwd, env) => {
        seen.push(`${tag}:tab parent=${env.HERDR_AGENTS_PARENT}`);
        return { pane: "w9:p1", cwd };
      },
      stage: async (dir, as) => {
        seen.push(`${tag}:stage ${as === dir ? "same" : as.replace(/-[^-]+$/, "-X")}`);
      },
      agentStart: async (_i, _p, _k, args) => {
        seen.push(`${tag}:start mcp=${args.includes("--mcp-config")}`);
      },
      agentPromptWait: async () => {
        seen.push(`${tag}:wait`);
        return { status: "idle", pane: "w9:p1", sessionPath: "/remote/s.jsonl" };
      },
      readFile: async (p) => {
        seen.push(`${tag}:read ${p}`);
        return JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi from box" }] } });
      },
      paneClose: async () => {
        seen.push(`${tag}:close`);
      },
    });
    const prev = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p1";
    const m = new Manager(piStub(), { ...DEFAULTS }, tagged("local"));
    try {
      const r = await m.spawn({ ...base, machine: "box", harness: "claude" });
      expect(r.text).toContain("hi from box");
      expect(r.text).toContain("| box |");
      expect(m.children.get(r.id)?.machine).toEqual(box);
      expect(r.id).toMatch(/^claude-general-purpose-\d+$/);
      await m.kill(r.id);
      await m.spawn({ ...base, harness: "claude" });
    } finally {
      if (prev === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = prev;
    }
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
  });

  it("rejects an unknown machine before creating anything", async () => {
    let tabs = 0;
    const fake: Herdr = {
      ...emptyHerdr(),
      machineList: async () => [box],
      tabCreate: async () => {
        tabs++;
        return { pane: "w9:p1", cwd: "/" };
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await expect(m.spawn({ ...base, machine: "nope" })).rejects.toThrow("unknown machine nope. Saved machines: box");
    expect(tabs).toBe(0);
  });

  it("maps the parent cwd under home to a remote-home-relative one", () => {
    expect(machineCwd("/Users/me/code/x", "/Users/me")).toBe("code/x");
    expect(machineCwd("/Users/me", "/Users/me")).toBe("~");
    expect(machineCwd("/opt/x", "/Users/me")).toBe("/opt/x");
    expect(sameDir("/home/you/code/x", "code/x")).toBe(true);
    expect(sameDir("/home/you", "code/x")).toBe(false);
    expect(sameDir("/home/you", "~")).toBe(true);
    expect(sameDir("/opt/x/", "/opt/x")).toBe(true);
  });

  it("lists saved machines in the Agent description, none when there are none", () => {
    const withBox = createTools(piStub(), () => "/", { ...emptyHerdr(), machineLabels: () => ["box", "devbox"] });
    expect(withBox.agent.description).toContain("Saved machines: box, devbox.");
    expect(createTools(piStub(), () => "/", emptyHerdr()).agent.description).not.toContain("Saved machines");
  });

  it("closes the tab and fails when herdr fell back to another cwd", async () => {
    const closed: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      tabCreate: async () => ({ pane: "w9:p1", cwd: "/home/me" }),
      paneClose: async (p) => {
        closed.push(p);
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await expect(m.spawn({ ...base, cwd: "/missing/" })).rejects.toThrow("cwd /missing/ does not exist on this machine");
    expect(closed).toEqual(["w9:p1"]);
  });

  it("a machine child that loses its wait goes idle, a local one is killed", async () => {
    const fake: Herdr = {
      ...emptyHerdr(),
      machineList: async () => [box],
      agentPromptWait: async () => {
        throw new HerdrError("bridge gone", "ssh_failed");
      },
      agentGet: async () => {
        throw new HerdrError("unreachable");
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 100;
    await expect(m.spawn({ ...base, machine: "box" })).rejects.toThrow("bridge gone");
    await expect(m.spawn(base)).rejects.toThrow("bridge gone");
    expect(m.list().map((c) => c.status)).toEqual(["idle", "killed"]);
  });

  it("a startup dialog pauses the child until a person answers, then the prompt goes in", async () => {
    const seen: string[] = [];
    const sent: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      agentStart: async () => {
        throw new HerdrError("blocked during startup", "agent_not_ready");
      },
      agentWaitUntil: async (_id, states) => {
        seen.push(`wait ${states.join(",")}`);
        return { status: "idle", pane: "w1:p9" };
      },
      agentPromptWait: async (_id, text) => {
        seen.push(`prompt ${text}`);
        return { status: "idle", pane: "w1:p9" };
      },
      paneClose: async () => {
        seen.push("close");
      },
    };
    const m = new Manager({ ...piStub(), deliver: (t) => sent.push(t) }, DEFAULTS, fake);
    // foreground: the parent keeps waiting while a person answers
    const r = await m.spawn(base);
    expect(r.status).toBe("idle");
    expect(seen).toEqual(["wait idle", "prompt go"]);
    expect(sent).toHaveLength(0);
    // background: blocked comes back at once, the report is delivered later
    seen.length = 0;
    const b = await m.spawn({ ...base, background: true });
    expect(b.status).toBe("blocked");
    expect(b.text).toContain("startup prompt in pane w1:p9");
    expect(b.text).toContain("A person has to answer it");
    await new Promise((res) => setTimeout(res, 10));
    expect(seen).toEqual(["wait idle", "prompt go"]);
    expect(m.children.get(b.id)?.status).toBe("idle");
    expect(sent).toHaveLength(1);
  });

  it("keeps the pane after a turn, SendMessage resumes it and delivers the report", async () => {
    const closed: string[] = [];
    const prompts: string[] = [];
    const sent: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      paneClose: async (p) => {
        closed.push(p);
      },
      agentPromptWait: async (_id, text) => {
        prompts.push(text);
        return { status: "idle", pane: "w1:p8" };
      },
    };
    const m = new Manager({ ...piStub(), deliver: (t) => sent.push(t) }, DEFAULTS, fake);
    const a = await m.spawn(base);
    expect(a.status).toBe("idle");
    expect(a.text).toContain("is idle");
    expect(closed).toEqual([]);
    await m.send(a.id, "more", "message");
    expect(m.children.get(a.id)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toEqual(["go", "more"]);
    expect(m.children.get(a.id)?.status).toBe("idle");
    expect(sent).toHaveLength(1);
    await m.kill(a.id);
    expect(closed).toEqual(["w1:p9"]);
  });
});

describe("listing and busy children", () => {
  it("shows the queue place, hides killed children, refuses to resume a busy child", async () => {
    let starts = 0;
    const fake: Herdr = {
      ...emptyHerdr(),
      agentStart: async () => {
        starts++;
      },
      agentPromptWait: () => new Promise(() => {}),
    };
    const dir = tmp();
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "herdr-agents.json"), JSON.stringify({ maxConcurrent: 1 }));
    const tools = createTools(piStub(), () => dir, fake);
    const spawn = (name: string) =>
      tools.agent.execute({ prompt: "p", description: "d", name, run_in_background: true });
    await spawn("a");
    await spawn("b");
    await spawn("c");
    const listed = (await tools.list.execute({})).text;
    expect(listed).toContain("queued #1/2");
    expect(listed).toContain("queued #2/2");

    const busy = await tools.agent.execute({ prompt: "p", description: "d", resume: "pi-a-1" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("kind=interrupt");

    await tools.kill.execute({ agent_id: "pi-c-3" });
    expect((await tools.list.execute({})).text).not.toContain("pi-c-3");
    expect((await tools.list.execute({ status: "killed" })).text).toContain("pi-c-3");
    expect((await tools.list.execute({ relation: "peer" })).text).toBe("no other agents");

    // The killed queued child never launches: the freed slot goes to the next one.
    await tools.kill.execute({ agent_id: "pi-b-2" });
    await tools.kill.execute({ agent_id: "pi-a-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(1);
    await spawn("d");
    expect(starts).toBe(2);
  });
});

describe("premature idle", () => {
  it("keeps waiting when herdr says idle mid tool call and working right after", async () => {
    const f = join(tmp(), "s.jsonl");
    const line = (role: string, stopReason: string, text: string) =>
      `${JSON.stringify({ type: "message", message: { role, stopReason, content: [{ type: "text", text }] } })}\n`;
    writeFileSync(f, line("user", "", "go") + line("assistant", "toolUse", ""));
    let waits = 0;
    const fake: Herdr = {
      ...emptyHerdr(),
      agentPromptWait: async () => ({ status: "idle", pane: "w1:p9", sessionPath: f }),
      agentGet: async () => ({ status: "working", pane: "w1:p9", sessionPath: f }),
      agentWait: async () => {
        waits++;
        writeFileSync(f, line("user", "", "go") + line("assistant", "stop", "really finished"));
        return { status: "idle", pane: "w1:p9", sessionPath: f };
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.settleMs = 10;
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(waits).toBe(1);
    expect(r.text).toContain("really finished");
  });
});
