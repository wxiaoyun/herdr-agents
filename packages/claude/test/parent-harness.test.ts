import { spawn } from "node:child_process";
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
      paneRun: () => Effect.void,
      paneReportAgent: () => Effect.void,
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

  it.effect("falls back to pane run when the pane is blocked", () =>
    Effect.gen(function* () {
      const runs: string[] = [];
      const p = yield* parent({
        agentPrompt: () => Effect.fail(new HerdrError({ message: "blocked", code: "agent_blocked" })),
        paneRun: (_p, t) => Effect.sync(() => runs.push(t)),
      });
      yield* p.deliver("hi", "follow_up");
      expect(runs).toEqual(["[herdr-agents delivery: agent output, not typed by the user]\nhi"]);
    }),
  );

  it.effect("reports blocked and working to herdr", () =>
    Effect.gen(function* () {
      const states: string[] = [];
      const p = yield* parent({ paneReportAgent: (_p, s) => Effect.sync(() => states.push(s)) });
      yield* p.setBlocked(true, "awaiting parent");
      yield* p.setBlocked(false);
      expect(states).toEqual(["blocked", "working"]);
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
