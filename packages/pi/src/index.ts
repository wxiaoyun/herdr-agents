/**
 * pi parent harness: registers the shared tools with pi, delivers reports
 * through pi's message queue and flips herdr's blocked state through pi's
 * event bus.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTools, logNow, messageOf, ParentHarness } from "@herdr-agents/core";
import { Effect, Layer } from "effect";

export default async function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    logNow("disabled", { reason: "not inside a herdr pane" });
    return;
  }

  let cwd = process.cwd();
  let model: string | undefined;
  let awaitingParent = false;
  let busy = false;

  const setBlocked = (active: boolean, label?: string) =>
    Effect.sync(() => {
      awaitingParent = active;
      pi.events.emit("herdr:blocked", { active, label });
    });

  const parent = Layer.succeed(ParentHarness, {
    harness: "pi",
    cwd: () => cwd,
    busy: () => busy,
    model: () => model,
    thinking: () => pi.getThinkingLevel(),
    // Synchronous, so `flush` can run inside pi's turn-end handler.
    deliver: (text, notify) =>
      Effect.sync(() => {
        if (notify === "follow_up") {
          pi.sendUserMessage(text, { deliverAs: "followUp" });
        } else {
          pi.sendMessage(
            { customType: "herdr-subagent", content: text, display: true },
            { deliverAs: "nextTurn" },
          );
        }
      }),
    setBlocked,
  });

  // child side: clear herdr "blocked" once the parent's reply arrives
  pi.on("input", () => {
    if (awaitingParent) Effect.runSync(setBlocked(false));
  });

  const tools = await createTools(parent);

  // pi drains follow-ups inside the same run once the loop would stop. A
  // Report the agent already read with GetAgentResult would come back as a
  // user message, and the agent's reply to it would replace its real Report.
  // So Deliveries are held during the run and go in at its last turn, which
  // pi awaits before it polls the follow-up queue.
  const idle = () => {
    busy = false;
    tools.flush();
  };
  pi.on("agent_start", () => {
    busy = true;
  });
  pi.on("turn_start", () => {
    busy = true;
  });
  pi.on("turn_end", (e) => {
    if (!e.toolResults.length) idle();
  });
  pi.on("agent_end", idle);

  const snippets: Record<string, Partial<Parameters<typeof pi.registerTool>[0]>> = {
    Agent: {
      promptSnippet:
        "Spawn a child pi or Claude Code agent (profiles: general-purpose, Worker, Scout, plus user profiles)",
      promptGuidelines: [
        "Use Agent with subagent_type Scout for read-only searches, pass a cheap fast model.",
        "Use Agent with run_in_background true for long independent work, the report arrives as a later message.",
        "Use Agent with harness claude to run the child in Claude Code instead of pi.",
      ],
    },
    SendMessage: {
      promptGuidelines: [
        "Use SendMessage without `to` to ask the parent agent a clarifying question, then end the turn and wait for the reply.",
        "Use SendMessage with `to` set to an idle child's id to give it a follow-up task, its report arrives as a later message.",
        "Use ListAgents to see every agent in herdr, including peers you did not spawn. SendMessage reaches any of them, Agent resume gives an idle pi or claude peer a task and returns its report.",
      ],
    },
  };

  for (const t of tools.all) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters as any,
      ...snippets[t.name],
      async execute(_id, p, signal, _u, ctx) {
        cwd = ctx.cwd;
        model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const r = await t.execute(p, signal);
        return {
          content: [{ type: "text" as const, text: r.text }],
          details: r.details ?? {},
          ...(r.isError ? { isError: true } : {}),
        };
      },
    });
  }

  const m = tools.manager;
  // ponytail: completions reuse one listing for 5s, since listing runs a
  // herdr call per saved machine; drop the cache if staleness ever bites.
  const listCached = await tools.run(Effect.cachedWithTTL(m.agents(), "5 seconds"));

  const send = async (to: string, message: string, notify: (t: string, k: "info" | "error") => void) => {
    const r = await tools.send.execute({ to, message });
    notify(r.text, r.isError ? "error" : "info");
  };

  pi.registerCommand("agents", {
    description: "List herdr agents, focus, message or kill one. `/agents send <id> <message>` messages one directly",
    async getArgumentCompletions(prefix) {
      const m = prefix.match(/^send\s+(\S*)$/);
      if (!m)
        return !prefix.includes(" ") && "send".startsWith(prefix)
          ? [{ value: "send ", label: "send", description: "message an agent" }]
          : null;
      const items = (await tools.run(listCached))
        .filter((a) => a.id.startsWith(m[1]))
        .map((a) => ({
          value: `send ${a.id} `,
          label: a.id,
          description: `${a.relation} ${a.harness ?? "-"} ${a.status}${a.machine ? ` ${a.machine.label}` : ""}`,
        }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      const notify = (t: string, k: "info" | "error") => ctx.ui.notify(t, k);
      const direct = args.trim().match(/^send\s+(\S+)\s+([\s\S]+)$/);
      if (direct) return send(direct[1], direct[2], notify);
      if (args.trim()) return notify("usage: /agents [send <id> <message>]", "error");
      const all = await tools.run(m.agents());
      if (!all.length) return notify("no other agents", "info");
      const labels = all.map(
        (a) =>
          `${a.id}  ${a.relation.padEnd(6)} ${(a.harness ?? "-").padEnd(6)} ${a.status.padEnd(8)} ${(a.machine?.label ?? "local").padEnd(12)} ${a.child?.description ?? a.cwd ?? ""}`,
      );
      const pick = await ctx.ui.select("Agents", labels);
      if (!pick) return;
      const a = all[labels.indexOf(pick)];
      const actions = a.relation === "child" ? ["focus", "send", "kill", "cancel"] : ["focus", "send", "cancel"];
      const action = await ctx.ui.select(a.id, actions);
      if (action === "focus") await tools.run(m.focus(a.id)).catch((e) => notify(messageOf(e), "error"));
      if (action === "kill") await tools.run(m.kill(a.id)).catch((e) => notify(messageOf(e), "error"));
      if (action === "send") {
        const text = await ctx.ui.input(`Message ${a.id}`);
        if (text?.trim()) await send(a.id, text, notify);
      }
    },
  });
}
