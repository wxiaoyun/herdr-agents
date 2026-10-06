import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Herdr, type HerdrClient, HerdrError, type Tools } from "@herdr-agents/core";
import { Effect } from "effect";
import { makeClaudeParent } from "../src/parent-harness.ts";
import { handler } from "../src/server.ts";

const parent = (over: Partial<HerdrClient>) =>
  makeClaudeParent("w1:p1").pipe(
    Effect.provideService(Herdr, {
      agentPrompt: () => Effect.void,
      agentWaitUntil: () => Effect.succeed({ status: "working", pane: "w1:p1" }),
      paneRun: () => Effect.void,
      paneReportAgent: () => Effect.void,
      paneReleaseAgent: () => Effect.void,
      ...over,
    } as HerdrClient),
  );

describe("claude parent harness", () => {
  it.effect("types a report into its own pane", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const p = yield* parent({ agentPrompt: (id, t) => Effect.sync(() => prompts.push(`${id}:${t}`)) });
      yield* p.deliver("report text", "passive");
      expect(prompts).toEqual(["w1:p1:[herdr-agents delivery: agent output, not typed by the user]\nreport text"]);
    }),
  );

  it.effect("releases its own blocked report, and waits out a dialog instead of typing into it", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const note = (s: string) => Effect.sync(() => seen.push(s));
      let refusals = 0;
      const p = yield* parent({
        agentPrompt: () =>
          Effect.suspend(() =>
            refusals-- > 0 ? Effect.fail(new HerdrError({ message: "blocked", code: "agent_blocked" })) : note("prompt"),
          ),
        paneReleaseAgent: () => note("release"),
        agentWaitUntil: (_p, states) => note(`wait ${states}`).pipe(Effect.as({ status: "working", pane: "w1:p1" })),
        paneRun: () => note("run"),
      });
      refusals = 1;
      yield* p.deliver("hi", "follow_up");
      expect(seen).toEqual(["release", "prompt"]);
      seen.length = 0;
      refusals = 2;
      yield* p.deliver("hi", "follow_up");
      expect(seen).toEqual(["release", "wait idle,done,working", "prompt"]);
    }),
  );

  it.effect("reports blocked to herdr, then hands the state back to herdr's detection", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const p = yield* parent({
        paneReportAgent: (_p, s) => Effect.sync(() => seen.push(s)),
        paneReleaseAgent: () => Effect.sync(() => seen.push("released")),
      });
      yield* p.setBlocked(true, "awaiting parent");
      yield* p.setBlocked(false);
      expect(seen).toEqual(["blocked", "released"]);
    }),
  );
});

describe("mcp server", () => {
  const fakeTools = (): Pick<Tools, "all"> => {
    const t: any = {
      name: "Agent",
      description: "d",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      execute: async (p: any) => ({ text: `ran ${p.prompt}` }),
    };
    return { all: [t] };
  };

  it("answers initialize, tools/list and tools/call", async () => {
    const h = handler(fakeTools());
    const init: any = await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(init.protocolVersion).toBe("2024-11-05");
    expect(init.capabilities.tools).toBeDefined();
    expect(await h({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list: any = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.tools[0]).toMatchObject({ name: "Agent", inputSchema: { type: "object" } });
    const call: any = await h({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "Agent", arguments: { prompt: "x" } } });
    expect(call).toEqual({ content: [{ type: "text", text: "ran x" }], isError: false });
    await expect(h({ jsonrpc: "2.0", id: 4, method: "nope" })).rejects.toMatchObject({ code: -32601 });
  });

  it("a cancelled call aborts the tool's signal and gets no response", async () => {
    let signal: AbortSignal | undefined;
    const t: any = {
      name: "Agent",
      description: "d",
      parameters: { type: "object" },
      execute: (_p: unknown, s: AbortSignal) => {
        signal = s;
        return new Promise((r) => s.addEventListener("abort", () => r({ text: "detached" })));
      },
    };
    const h = handler({ all: [t] });
    const call = h({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "Agent", arguments: {} } });
    expect(signal?.aborted).toBe(false);
    expect(await h({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(await call).toBeUndefined();
  });

  it("serves disabled definitions without herdr I/O and logs each disabled harness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-disabled-"));
    const marker = join(dir, "herdr-called");
    const log = join(dir, "debug.log");
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf called > '${marker}'\nprintf '[]\\n'\n`, { mode: 0o755 });
    const env = { ...process.env, HERDR_ENV: "0", HERDR_PANE_ID: "", HERDR_AGENTS_LOG: log, PATH: `${dir}:${process.env.PATH}` };
    const run = (args: string[], input = "") => new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, args, { env });
      let out = "";
      let error = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { error += d; });
      p.on("error", reject);
      p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(error)));
      p.stdin.end(input);
    });
    const bin = fileURLToPath(new URL("../bin/herdr-agents-mcp.ts", import.meta.url));
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Agent", arguments: { prompt: "x" } } },
    ];
    const out = await run([bin], requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].result.tools).toHaveLength(5);
    expect(lines[1].result).toEqual({ content: [{ type: "text", text: "herdr-agents: not running inside a herdr pane" }], isError: true });
    const pi = fileURLToPath(new URL("../../pi/src/index.ts", import.meta.url));
    await run(["--input-type=module", "-e", `const {default: extension} = await import(${JSON.stringify(pi)}); await extension({});`]);
    expect(existsSync(marker)).toBe(false);
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain('stage=disabled harness="claude"');
    expect(logged).toContain('stage=disabled harness="pi"');
    expect(logged).not.toContain("stage=tools_created");
    expect(logged).not.toContain("stage=herdr:");
  });

  it("runs under plain node over stdio", async () => {
    const bin = fileURLToPath(new URL("../bin/herdr-agents-mcp.ts", import.meta.url));
    const p = spawn("node", [bin], { env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w0:p0" } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    for (let i = 0; i < 100 && out.split("\n").filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    p.kill();
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].result.serverInfo.name).toBe("herdr");
    expect(lines[1].result.tools.map((t: any) => t.name)).toEqual(["Agent", "GetAgentResult", "SendMessage", "KillAgent", "ListAgents"]);
  });
});
