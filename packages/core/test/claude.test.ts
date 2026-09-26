import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HerdrError } from "../src/herdr.ts";
import type { SpawnOpts } from "../src/manager.ts";
import { BUILTIN_PROFILES, loadProfiles, type Profile } from "../src/profiles.ts";
import { parseLastSpeaker, parseReport, sessionPathFor } from "../src/session.ts";
import type { Settings } from "../src/settings.ts";
import { base, emptyHerdr, manager, tools } from "./helpers.ts";

const readReport = (harness: "pi" | "claude", f: string) => parseReport(harness, readFileSync(f, "utf8"));
const lastSpeaker = (harness: "pi" | "claude", f: string) => parseLastSpeaker(harness, readFileSync(f, "utf8"));

/** Spawn a background child and capture what herdr `agent start` received. */
const startArgs = (opts: Partial<SpawnOpts>, settings: Partial<Settings> = {}) =>
  Effect.gen(function* () {
    let kind = "";
    let args: string[] = [];
    let staged: Record<string, string> = {};
    const m = yield* manager({
      settings,
      herdr: {
        ...emptyHerdr(),
        agentStart: (_id, _pane, k, a) =>
          Effect.sync(() => {
            kind = k;
            args = a;
            staged = Object.fromEntries(
              a.filter((v) => v.startsWith("/") && existsSync(v)).map((v) => [v, readFileSync(v, "utf8")]),
            );
          }),
      },
    });
    const r = yield* m.spawn({ ...base, harness: "claude", background: true, ...opts });
    const flag = (f: string) => args[args.indexOf(f) + 1];
    return { id: r.id, kind, args, flag, staged };
  });

describe("claude child spawn", () => {
  it.effect("starts a claude agent with claude-native flags", () =>
    Effect.gen(function* () {
      const { id, kind, args, flag } = yield* startArgs({
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
    }),
  );

  it.effect("uses auto mode where the model has it, acceptEdits elsewhere", () =>
    Effect.gen(function* () {
      const mode = (model?: string) => startArgs({ model }).pipe(Effect.map((r) => r.flag("--permission-mode")));
      expect(yield* mode()).toBe("auto");
      expect(yield* mode("claude-sonnet-5")).toBe("auto");
      expect(yield* mode("anthropic/claude-opus-4-6")).toBe("auto");
      expect(yield* mode("opus")).toBe("auto");
      expect(yield* mode("claude-haiku-4-5")).toBe("acceptEdits");
      expect(yield* mode("claude-opus-4-5-20251101")).toBe("acceptEdits");
    }),
  );
});

describe("claude child model", () => {
  it.effect("keeps bare ids and rejects non-anthropic providers", () =>
    Effect.gen(function* () {
      expect((yield* startArgs({ model: "haiku" })).flag("--model")).toBe("haiku");
      const m = yield* manager();
      const e = yield* Effect.flip(m.spawn({ ...base, harness: "claude", model: "openrouter/x", background: true }));
      expect(e.message).toContain("anthropic");
    }),
  );
});

describe("claude child prompt and tools", () => {
  const profile = (over: Partial<Profile>): Profile => ({
    name: "t",
    description: "",
    promptMode: "append",
    allowedSubagents: [],
    ...over,
  });

  it.effect("stages multi-line prompts as -file flags, keeps single lines inline", () =>
    Effect.gen(function* () {
      const multi = yield* startArgs({
        profile: profile({ systemPrompt: "a\nb", promptMode: "replace" }),
      });
      expect(multi.staged[multi.flag("--system-prompt-file")]).toBe("a\nb");
      const single = yield* startArgs({ profile: profile({ systemPrompt: "one" }) });
      expect(single.flag("--append-system-prompt")).toBe("one");
      expect(single.args).not.toContain("--append-system-prompt-file");
    }),
  );

  it.effect("translates builtin Scout tools, passes user tools verbatim", () =>
    Effect.gen(function* () {
      const scout = yield* startArgs({
        profile: BUILTIN_PROFILES.find((p) => p.name === "Scout")!,
      });
      expect(scout.flag("--tools")).toBe("Read,Bash,Grep,Glob,WebSearch");
      expect(scout.flag("--allowedTools")).toBe("Read,Bash,Grep,Glob,WebSearch");
      const user = yield* startArgs({ profile: profile({ tools: ["Edit", "Bash(git *)"] }) });
      expect(user.flag("--tools")).toBe("Edit,Bash(git *)");
    }),
  );

  it.effect("appends claudeArgs and resumes by session id", () =>
    Effect.gen(function* () {
      const { args } = yield* startArgs({}, { claudeArgs: ["--verbose"] });
      expect(args.at(-1)).toBe("--verbose");
      const { args: over } = yield* startArgs({}, { claudeArgs: ["--permission-mode", "plan"] });
      expect(over.filter((a) => a === "--permission-mode")).toHaveLength(1);
      expect(over[over.indexOf("--permission-mode") + 1]).toBe("plan");
    }),
  );

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
    expect(sessionPathFor("claude", "/Users/me/code/x.y", "abc", "/cfg")).toBe(
      "/cfg/projects/-Users-me-code-x-y/abc.jsonl",
    );
    expect(sessionPathFor("pi", "/x", "abc", "/cfg")).toBeUndefined();
  });
});

describe("claude resume", () => {
  it.effect("relaunches a gone child with --resume <session id>", () =>
    Effect.gen(function* () {
      let calls = 0;
      let args: string[] = [];
      const m = yield* manager({
        herdr: {
          ...emptyHerdr(),
          agentStart: (_id, _pane, _k, a) =>
            Effect.sync(() => {
              args = a;
            }),
          agentGet: () =>
            Effect.suspend(() => {
              calls++;
              // 1: after first launch, 2: liveness probe on resume, 3+: after relaunch
              if (calls === 2) return Effect.fail(new HerdrError({ message: "gone" }));
              return Effect.succeed({ status: "idle" as const, pane: "w1:p9", sessionId: "sess-1" });
            }),
        },
      });
      const opts: SpawnOpts = { ...base, harness: "claude", background: true };
      const first = yield* m.spawn(opts);
      yield* m.spawn({ ...opts, resume: first.id });
      expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    }),
  );
});

describe("harness selection", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "phs-tools-"));

  it.effect("drops the parent model on cross-harness spawn, keeps it on same harness", () =>
    Effect.gen(function* () {
      const kinds: Array<[string, string[]]> = [];
      const dir = cwd();
      const t = yield* tools({
        parent: { cwd: () => dir, model: () => "anthropic/claude-x" },
        herdr: {
          ...emptyHerdr(),
          agentStart: (_id, _pane, kind, a) =>
            Effect.sync(() => {
              kinds.push([kind, a]);
            }),
        },
      });
      yield* t.agent.run({ prompt: "p", description: "d", harness: "claude", run_in_background: true });
      yield* t.agent.run({ prompt: "p", description: "d", run_in_background: true });
      expect(kinds[0][0]).toBe("claude");
      expect(kinds[0][1]).not.toContain("--model");
      expect(kinds[1][0]).toBe("pi");
      expect(kinds[1][1]).toContain("anthropic/claude-x");
    }),
  );

  it.effect("reads harness from the profile frontmatter", () =>
    Effect.gen(function* () {
      const dir = cwd();
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "cc.md"),
        "---\ndescription: claude child\nharness: claude\ntools: [Read, Grep]\n---\nbody",
      );
      const p = yield* loadProfiles(dir, mkdtempSync(join(tmpdir(), "phs-agent-")));
      expect(p.get("cc")).toMatchObject({ harness: "claude", tools: ["Read", "Grep"], systemPrompt: "body" });
      expect(p.get("general-purpose")?.harness).toBeUndefined();
    }),
  );

  it.effect("tool param beats profile harness beats parent harness", () =>
    Effect.gen(function* () {
      const kinds: string[] = [];
      const dir = cwd();
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "cc.md"),
        "---\ndescription: d\nharness: claude\n---\n",
      );
      const t = yield* tools({
        parent: { cwd: () => dir },
        herdr: {
          ...emptyHerdr(),
          agentStart: (_id, _pane, kind) =>
            Effect.sync(() => {
              kinds.push(kind);
            }),
        },
      });
      const params = { prompt: "p", description: "d", run_in_background: true };
      yield* t.agent.run({ ...params, subagent_type: "cc" });
      yield* t.agent.run({ ...params, subagent_type: "cc", harness: "pi" });
      yield* t.agent.run(params);
      expect(kinds).toEqual(["claude", "pi", "pi"]);
    }),
  );
});
