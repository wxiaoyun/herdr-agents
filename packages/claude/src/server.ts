/**
 * Minimal MCP stdio server (JSON-RPC 2.0, newline delimited). Only what
 * Claude Code needs: initialize, tools/list, tools/call, ping.
 */
import { createInterface } from "node:readline";
import { createTools, logNow, type Tools } from "@herdr-agents/core";
import { claudeParent } from "./parent-harness.ts";

const PROTOCOL = "2025-06-18";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
}

export function handler(tools: Pick<Tools, "all">) {
  const byName = new Map(tools.all.map((t) => [t.name, t]));
  return async (msg: Rpc): Promise<unknown | undefined> => {
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "herdr", version: "0.2.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.all.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        };
      case "tools/call": {
        const t = byName.get(msg.params?.name);
        if (!t) throw Object.assign(new Error(`unknown tool ${msg.params?.name}`), { code: -32602 });
        const r = await t.execute(msg.params?.arguments ?? {});
        return { content: [{ type: "text", text: r.text }], isError: r.isError ?? false };
      }
      default:
        if (msg.id === undefined) return undefined; // notification
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  };
}

export function serve(tools: Pick<Tools, "all">): void {
  const handle = handler(tools);
  const write = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && msg.id !== null) write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e: any) {
      logNow("rpc_error", { method: msg.method, error: String(e) });
      if (msg.id !== undefined && msg.id !== null)
        write({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: String(e.message ?? e) } });
    }
  });
}

export async function main(): Promise<void> {
  const pane =
    process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
  const tools = await createTools(claudeParent(pane ?? ""));
  if (!pane) {
    // Still serve, but every tool errors: Claude shows a clear reason instead of a dead server.
    logNow("disabled", { reason: "not inside a herdr pane" });
    for (const t of tools.all) {
      t.execute = async () => ({ text: "herdr-agents: not running inside a herdr pane", isError: true });
    }
  }
  serve(tools);
}
