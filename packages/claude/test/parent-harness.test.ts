import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Herdr, HerdrError, type ToolSet } from "@herdr-agents/core";
import { describe, expect, it } from "vitest";
import { createClaudeParent } from "../src/parent-harness.ts";
import { handler } from "../src/server.ts";

const herdr = (over: Partial<Herdr>): Herdr =>
  ({
    agentPrompt: async () => {},
    paneRun: async () => {},
    paneReportAgent: async () => {},
    ...over,
  }) as Herdr;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("claude parent harness", () => {
  it("types a report into its own pane", async () => {
    const prompts: string[] = [];
    const pHarness = createClaudeParent("w1:p1", herdr({ agentPrompt: async (id, t) => { prompts.push(`${id}:${t}`); } }));
    pHarness.deliver("report text", "passive");
    await tick();
    expect(prompts).toEqual(["w1:p1:[herdr-agents delivery: agent output, not typed by the user]\nreport text"]);
  });

  it("falls back to pane run when the pane is blocked", async () => {
    const runs: string[] = [];
    const pHarness = createClaudeParent(
      "w1:p1",
      herdr({
        agentPrompt: async () => { throw new HerdrError("blocked", "agent_blocked"); },
        paneRun: async (_p, t) => { runs.push(t); },
      }),
    );
    pHarness.deliver("hi", "follow_up");
    await tick();
    expect(runs).toEqual(["[herdr-agents delivery: agent output, not typed by the user]\nhi"]);
  });

  it("reports blocked and working to herdr", async () => {
    const states: string[] = [];
    const pHarness = createClaudeParent("w1:p1", herdr({ paneReportAgent: async (_p, s) => { states.push(s); } }));
    pHarness.setBlocked(true, "awaiting parent");
    pHarness.setBlocked(false);
    await tick();
    expect(states).toEqual(["blocked", "working"]);
  });
});

describe("mcp server", () => {
  const fakeTools = (): ToolSet => {
    const t: any = {
      name: "Agent",
      description: "d",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      execute: async (p: any) => ({ text: `ran ${p.prompt}` }),
    };
    return { all: [t] } as any;
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
