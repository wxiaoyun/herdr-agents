import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Herdr } from "../src/herdr.ts";
import { Manager, type SpawnOpts } from "../src/manager.ts";
import type { ParentHarness } from "../src/parent-harness.ts";
import { BUILTIN_PROFILES, loadProfiles, type Profile } from "../src/profiles.ts";
import { lastSpeaker, readReport, sessionPathFor } from "../src/session.ts";
import { DEFAULTS } from "../src/settings.ts";
import { createTools } from "../src/tools.ts";

const pHarness = (): ParentHarness => ({ harness: "pi", deliver: () => {}, setBlocked: () => {} });

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

/** Spawn a background child and capture what herdr `agent start` received. */
async function startArgs(opts: Partial<SpawnOpts>, settings = DEFAULTS) {
  let kind = "";
  let args: string[] = [];
  let staged: Record<string, string> = {};
  const fake: Herdr = {
    ...emptyHerdr(),
    agentStart: async (_id, _pane, k, a) => {
      kind = k;
      args = a;
      staged = Object.fromEntries(
        a.filter((v) => v.startsWith("/") && existsSync(v)).map((v) => [v, readFileSync(v, "utf8")]),
      );
    },
  };
  const m = new Manager(pHarness(), settings, fake);
  const r = await m.spawn({
    prompt: "go",
    description: "d",
    profile: BUILTIN_PROFILES[0],
    harness: "claude",
    cwd: "/",
    background: true,
    timeoutMs: 0,
    depth: 1,
    ...opts,
  });
  const flag = (f: string) => args[args.indexOf(f) + 1];
  return { id: r.id, kind, args, flag, staged };
}

describe("claude child spawn", () => {
  it("starts a claude agent with claude-native flags", async () => {
    const { id, kind, args, flag } = await startArgs({
      model: "anthropic/claude-sonnet-4-5",
      thinking: "minimal",
    });
    expect(kind).toBe("claude");
    expect(flag("--name")).toBe(id);
    expect(flag("--model")).toBe("claude-sonnet-4-5");
    expect(flag("--effort")).toBe("low");
    expect(flag("--permission-mode")).toBe("acceptEdits");
    expect(JSON.parse(flag("--mcp-config")).mcpServers.herdr.args[0]).toMatch(
      /herdr-agents-mcp\.ts$/,
    );
    expect(args).not.toContain("--thinking");
    expect(args.some((a) => a.includes("\n"))).toBe(false);
  });

  it("uses auto mode where the model has it, acceptEdits elsewhere", async () => {
    const mode = async (model?: string) => (await startArgs({ model })).flag("--permission-mode");
    expect(await mode()).toBe("auto");
    expect(await mode("claude-sonnet-5")).toBe("auto");
    expect(await mode("anthropic/claude-opus-4-6")).toBe("auto");
    expect(await mode("opus")).toBe("auto");
    expect(await mode("claude-haiku-4-5")).toBe("acceptEdits");
    expect(await mode("claude-opus-4-5-20251101")).toBe("acceptEdits");
  });
});

describe("claude child model", () => {
  it("keeps bare ids and rejects non-anthropic providers", async () => {
    expect((await startArgs({ model: "haiku" })).flag("--model")).toBe("haiku");
    const m = new Manager(pHarness(), DEFAULTS, emptyHerdr());
    await expect(
      m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "claude",
        model: "openrouter/x",
        cwd: "/",
        background: true,
        timeoutMs: 0,
        depth: 1,
      }),
    ).rejects.toThrow("anthropic");
  });
});

describe("claude child prompt and tools", () => {
  const profile = (over: Partial<Profile>): Profile => ({
    name: "t",
    description: "",
    promptMode: "append",
    allowedSubagents: [],
    ...over,
  });

  it("stages multi-line prompts as -file flags, keeps single lines inline", async () => {
    const multi = await startArgs({
      profile: profile({ systemPrompt: "a\nb", promptMode: "replace" }),
    });
    expect(multi.staged[multi.flag("--system-prompt-file")]).toBe("a\nb");
    const single = await startArgs({ profile: profile({ systemPrompt: "one" }) });
    expect(single.flag("--append-system-prompt")).toBe("one");
    expect(single.args).not.toContain("--append-system-prompt-file");
  });

  it("translates builtin Scout tools, passes user tools verbatim", async () => {
    const scout = await startArgs({
      profile: BUILTIN_PROFILES.find((p) => p.name === "Scout")!,
    });
    expect(scout.flag("--tools")).toBe("Read,Bash,Grep,Glob,WebSearch");
    expect(scout.flag("--allowedTools")).toBe("Read,Bash,Grep,Glob,WebSearch");
    const user = await startArgs({ profile: profile({ tools: ["Edit", "Bash(git *)"] }) });
    expect(user.flag("--tools")).toBe("Edit,Bash(git *)");
  });

  it("appends claudeArgs and resumes by session id", async () => {
    const { args } = await startArgs({}, { ...DEFAULTS, claudeArgs: ["--verbose"] });
    expect(args.at(-1)).toBe("--verbose");
    const { args: over } = await startArgs(
      {},
      { ...DEFAULTS, claudeArgs: ["--permission-mode", "plan"] },
    );
    expect(over.filter((a) => a === "--permission-mode")).toHaveLength(1);
    expect(over[over.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("yields no text on a garbage claude session so the screen fallback applies", () => {
    const f = join(mkdtempSync(join(tmpdir(), "phs-g-")), "s.jsonl");
    writeFileSync(f, "not json\n{\"type\":\"user\"}");
    expect(readReport("claude", f).text).toBe("");
  });
});

describe("claude session file", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "phs-claude-"));
  const entry = (type: string, id: string, content: unknown[], out = 5) =>
    JSON.stringify({
      type,
      message: { id, role: type, content, usage: { input_tokens: 10, output_tokens: out } },
    });

  it("reads last assistant text and counts usage once per message id", () => {
    const f = join(dir(), "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "permission-mode", mode: "default" }),
        entry("assistant", "m1", [{ type: "thinking", thinking: "hm" }]),
        entry("assistant", "m1", [{ type: "tool_use", name: "Read" }]),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }),
        entry("assistant", "m2", [{ type: "text", text: "final answer" }], 7),
      ].join("\n"),
    );
    expect(readReport("claude", f)).toEqual({
      text: "final answer",
      usage: { input: 20, output: 12, cost: 0, turns: 2 },
    });
    expect(lastSpeaker("claude", f)).toBe("assistant");
  });

  it("treats a pending tool call as an unfinished turn", () => {
    const f = join(dir(), "s.jsonl");
    writeFileSync(
      f,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use" }] },
      }),
    );
    expect(lastSpeaker("claude", f)).toBe("user");
  });

  it("derives the session path from cwd and id", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    try {
      expect(sessionPathFor("claude", "/Users/me/code/x.y", "abc")).toBe(
        "/cfg/projects/-Users-me-code-x-y/abc.jsonl",
      );
      expect(sessionPathFor("pi", "/x", "abc")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("claude resume", () => {
  it("relaunches a gone child with --resume <session id>", async () => {
    let calls = 0;
    let args: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      agentStart: async (_id, _pane, _k, a) => {
        args = a;
      },
      agentGet: async () => {
        calls++;
        // 1: after first launch, 2: liveness probe on resume, 3+: after relaunch
        if (calls === 2) throw new Error("gone");
        return { status: "idle", pane: "w1:p9", sessionId: "sess-1" };
      },
    };
    const m = new Manager(pHarness(), DEFAULTS, fake);
    const base: SpawnOpts = {
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "claude",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    };
    const first = await m.spawn(base);
    await m.spawn({ ...base, resume: first.id });
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
  });
});

describe("harness selection", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "phs-tools-"));

  it("drops the parent model on cross-harness spawn, keeps it on same harness", async () => {
    const kinds: Array<[string, string[]]> = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      agentStart: async (_id, _pane, kind, a) => {
        kinds.push([kind, a]);
      },
    };
    const h: ParentHarness = { ...pHarness(), model: () => "anthropic/claude-x" };
    const tools = createTools(h, cwd, fake);
    await tools.agent.execute({ prompt: "p", description: "d", harness: "claude", run_in_background: true });
    await tools.agent.execute({ prompt: "p", description: "d", run_in_background: true });
    expect(kinds[0][0]).toBe("claude");
    expect(kinds[0][1]).not.toContain("--model");
    expect(kinds[1][0]).toBe("pi");
    expect(kinds[1][1]).toContain("anthropic/claude-x");
  });

  it("reads harness from the profile frontmatter", () => {
    const dir = cwd();
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agents", "cc.md"),
      "---\ndescription: claude child\nharness: claude\ntools: [Read, Grep]\n---\nbody",
    );
    const p = loadProfiles(dir, mkdtempSync(join(tmpdir(), "phs-agent-")));
    expect(p.get("cc")).toMatchObject({ harness: "claude", tools: ["Read", "Grep"], systemPrompt: "body" });
    expect(p.get("general-purpose")?.harness).toBeUndefined();
  });

  it("tool param beats profile harness beats parent harness", async () => {
    const kinds: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      agentStart: async (_id, _pane, kind) => {
        kinds.push(kind);
      },
    };
    const dir = cwd();
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agents", "cc.md"),
      "---\ndescription: d\nharness: claude\n---\n",
    );
    const tools = createTools(pHarness(), () => dir, fake);
    const base = { prompt: "p", description: "d", run_in_background: true };
    await tools.agent.execute({ ...base, subagent_type: "cc" });
    await tools.agent.execute({ ...base, subagent_type: "cc", harness: "pi" });
    await tools.agent.execute(base);
    expect(kinds).toEqual(["claude", "pi", "pi"]);
  });
});
