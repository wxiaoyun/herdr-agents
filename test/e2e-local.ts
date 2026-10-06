/** Local live check when no authenticated saved machine is available. */
import assert from "node:assert/strict";
import { Effect, Layer, Queue } from "effect";
import { client } from "../packages/core/src/herdr.ts";
import { ParentHarness } from "../packages/core/src/parent-harness.ts";
import { createTools } from "../packages/core/src/tools.ts";

assert.equal(process.env.HERDR_ENV, "1", "run from a herdr pane");
assert.ok(process.env.HERDR_PANE_ID, "missing HERDR_PANE_ID");
const reports = Effect.runSync(Queue.unbounded<string>());
const tools = await createTools(Layer.succeed(ParentHarness, {
  harness: "pi",
  cwd: () => process.cwd(),
  deliver: (text) => Queue.offer(reports, text).pipe(Effect.asVoid),
  setBlocked: () => Effect.void,
}));
const check = (name: string, ok: unknown, detail: string) => {
  assert.ok(ok, `${name}: ${detail}`);
  console.log(`PASS ${name}`);
};
const nextReport = () => tools.run(Queue.take(reports).pipe(Effect.timeout("2 minutes")));
try {
  const first = await tools.agent.execute({
    prompt: "Reply with exactly LOCAL-PONG-1. Do not use tools.",
    description: "local cleanup smoke",
    harness: "pi",
    model: process.env.E2E_PI_MODEL,
    name: "cleanup-smoke",
    timeout_ms: 120000,
  });
  check("foreground spawn", !first.isError && first.text.includes("LOCAL-PONG-1"), first.text);
  const id = first.details!.id as string;
  const background = await tools.agent.execute({
    prompt: "Use bash to run sleep 10. Then reply with exactly LOCAL-PONG-2.",
    description: "local background smoke",
    resume: id,
    run_in_background: true,
    timeout_ms: 120000,
  });
  check("background continuation", !background.isError && background.details?.status === "running", background.text);
  await tools.run(client().agentWaitUntil(id, ["working"]).pipe(Effect.timeout("30 seconds")));
  const screen = await tools.result.execute({ agent_id: id });
  const body = screen.text.split("\n").slice(2).join("\n").trim();
  check("live screen and running status", !screen.isError && screen.text.includes("| running |") && screen.text.includes("live screen") && body, screen.text);
  const report = await nextReport();
  check("background final report", report.includes("LOCAL-PONG-2") && report.includes("| idle |"), report);
  const sent = await tools.send.execute({ to: id, message: "Reply with exactly LOCAL-PONG-3. Do not use tools." });
  check("SendMessage continuation", !sent.isError, sent.text);
  const continuation = await nextReport();
  check("SendMessage final report", continuation.includes("LOCAL-PONG-3"), continuation);
  const result = await tools.result.execute({ agent_id: id, wait: true, timeout_ms: 120000 });
  check("GetAgentResult latest idle report", !result.isError && result.text.includes("LOCAL-PONG-3") && result.text.includes("| idle |"), result.text);
  const killed = await tools.kill.execute({ agent_id: id });
  check("kill", !killed.isError, killed.text);
  const gone = await tools.run(client().agentGet(id).pipe(Effect.result));
  check("pane cleanup", gone._tag === "Failure", JSON.stringify(gone));
} finally {
  for (const child of tools.manager.list()) {
    if (child.status !== "killed") await tools.kill.execute({ agent_id: child.id });
  }
  await tools.dispose();
}
