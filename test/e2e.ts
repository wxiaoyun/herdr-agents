/**
 * Live end-to-end check against real herdr, pi and Claude Code. See docs/e2e.md.
 * Two tool sets in one process stand in for two sessions: A spawns the
 * children, B sees them only as peers. Exits non-zero when a check fails.
 */
import { execFileSync } from "node:child_process";
import { Effect, Layer } from "effect";
import { Herdr } from "../packages/core/src/herdr.ts";
import { FileLogger } from "../packages/core/src/log.ts";
import { ParentHarness } from "../packages/core/src/parent-harness.ts";
import { createTools, type ToolResult } from "../packages/core/src/tools.ts";

const saved = await Effect.runPromise(
  Herdr.use((h) => h.machineList()).pipe(Effect.provide(Layer.merge(Herdr.layer, FileLogger))),
);
const machine = process.env.E2E_MACHINE ?? saved.find((m) => m.enabled !== false)?.label;
if (!machine) {
  console.error("no saved herdr machine: set E2E_MACHINE or run `herdr machine add`");
  process.exit(2);
}
const claudeModel = process.env.E2E_CLAUDE_MODEL ?? "claude-haiku-4-5";
const piModel = process.env.E2E_PI_MODEL;

const stub = Layer.succeed(ParentHarness, {
  harness: "claude",
  cwd: () => process.cwd(),
  deliver: () => Effect.void,
  setBlocked: () => Effect.void,
});
const A = await createTools(stub);
const B = await createTools(stub);

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n${detail.slice(0, 800)}`}`);
};
const has = (r: ToolResult, s: string) => !r.isError && r.text.includes(s);
const reply = (tok: string) => `Reply with exactly ${tok} and nothing else. Do not use tools.`;
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const herdr = (...a: string[]) => execFileSync("herdr", a, { encoding: "utf8" });

let lid: string | undefined;
let rid: string | undefined;
try {
  const local = await A.agent.execute({ prompt: reply("PONG-1"), description: "e2e local pi", harness: "pi", model: piModel, name: "e2e" });
  check("A spawns a local pi child", has(local, "PONG-1"), local.text);
  const remote = await A.agent.execute({ prompt: reply("PONG-2"), description: "e2e remote claude", harness: "claude", machine, cwd: "~", model: claudeModel, name: "e2e" });
  check(`A spawns a claude child on ${machine}`, has(remote, "PONG-2"), remote.text);
  if (local.isError || remote.isError) throw new Error("spawn failed, later checks need both children");
  lid = local.details?.id as string;
  rid = `${machine}/${remote.details?.id}`;

  const line = (r: ToolResult, id: string) => r.text.split("\n").filter((l) => l.startsWith(`${id}  `));
  const aList = await A.list.execute({});
  check("A lists both as child, once each", [lid, rid].every((id) => line(aList, id).length === 1 && line(aList, id)[0].includes("  child  ")), aList.text);
  const bList = await B.list.execute({});
  check("B lists both as peer, once each", [lid, rid].every((id) => line(bList, id).length === 1 && line(bList, id)[0].includes("  peer  ")), bList.text);

  const r3 = await B.agent.execute({ prompt: reply("PONG-3"), description: "e2e", resume: lid });
  check("B resumes the local peer and gets its report", has(r3, `[peer ${lid}`) && has(r3, "PONG-3"), r3.text);
  const r4 = await B.agent.execute({ prompt: reply("PONG-4"), description: "e2e", resume: rid });
  check("B resumes the remote peer and gets its report", has(r4, "PONG-4"), r4.text);
  const g = await B.result.execute({ agent_id: rid });
  check("B reads the remote peer's report", has(g, "PONG-4"), g.text);
  const a = await A.result.execute({ agent_id: lid });
  check("A sees its child's latest report, not the stale one", has(a, "PONG-3"), a.text);

  const k = await B.kill.execute({ agent_id: lid });
  check("B cannot kill a peer", !!k.isError && k.text.includes("only its parent"), k.text);
  await B.send.execute({ to: lid, message: "Write the numbers 1 to 300, one per line, no tools." });
  await nap(1500);
  const busy = await B.agent.execute({ prompt: "x", description: "e2e", resume: lid });
  check("B cannot resume a busy peer", !!busy.isError && busy.text.includes("only an idle peer"), busy.text);
  herdr("agent", "wait", lid, "--until", "idle", "--until", "done", "--timeout", "180000");

  // The pi child uses its own extension: it must see this session as parent and reach the remote agent.
  const self = await A.agent.execute({
    prompt: `Call ListAgents and paste its output verbatim. Then call SendMessage with to="${rid}" and message "hello from pi". Then reply DONE.`,
    description: "e2e",
    resume: lid,
  });
  check("pi child runs ListAgents and SendMessage", has(self, "DONE"), self.text);
  const [, remoteRef] = rid.split("/");
  const remoteScreen = () => herdr("--machine", machine, "agent", "read", remoteRef, "--source", "recent-unwrapped", "--lines", "60");
  await nap(3000);
  check("remote agent received the pi child's message", remoteScreen().includes(`[from ${lid}] hello from pi`), remoteScreen());

  // pi /agents send: completion popup, then a direct send.
  const pane = JSON.parse(herdr("agent", "get", lid)).result.agent.pane_id;
  const screen = () => herdr("pane", "read", pane, "--source", "visible", "--lines", "60");
  herdr("pane", "send-text", pane, `/agents send ${machine.slice(0, 4)}`);
  // Completion lists agents over ssh per machine: poll instead of guessing a delay.
  // No selection arrow: another agent on the machine may sort first.
  const popup = new RegExp(`${rid}\\s+peer`);
  for (let i = 0; i < 20 && !popup.test(screen()); i++) await nap(500);
  check("pi /agents send completes remote ids", popup.test(screen()), screen());
  herdr("agent", "send-keys", lid, "ctrl+u");
  herdr("pane", "send-text", pane, `/agents send ${rid} hello from the pi command`);
  herdr("agent", "send-keys", lid, "enter");
  await nap(8000);
  check("pi /agents send reaches the remote agent", remoteScreen().includes(`[from ${lid}] hello from the pi command`), remoteScreen());
} catch (e) {
  check("run completes", false, String(e));
} finally {
  for (const id of [lid, rid]) if (id) await A.kill.execute({ agent_id: id });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
