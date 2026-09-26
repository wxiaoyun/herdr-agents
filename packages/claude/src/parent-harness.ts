/**
 * Claude Code parent harness. Claude has no extension API, so reports are
 * typed into this session's own pane through herdr (they arrive as a user
 * message) and the blocked state is reported to herdr directly.
 */
import { Herdr, isHerdrCode, log, ParentHarness, type ParentHarnessShape } from "@herdr-agents/core";
import { Effect, Layer } from "effect";

export const makeClaudeParent = (pane: string): Effect.Effect<ParentHarnessShape, never, Herdr> =>
  Effect.gen(function* () {
    const h = yield* Herdr;
    return {
      harness: "claude",
      cwd: () => process.cwd(),
      // notify is ignored: typing into the pane always triggers a turn.
      deliver: (report) => {
        // It lands as a user message, so say who really wrote it.
        const text = `[herdr-agents delivery: agent output, not typed by the user]\n${report}`;
        return h.agentPrompt(pane, text).pipe(
          Effect.catch((e) => (isHerdrCode(e, "agent_blocked") ? h.paneRun(pane, text) : Effect.fail(e))),
          Effect.catch((e) => log("deliver_failed", { pane, error: e.message })),
        );
      },
      // ponytail: herdr's screen manifest is the state authority for claude;
      // this report is best effort and may be overridden on the next redraw.
      setBlocked: (active, label) =>
        h
          .paneReportAgent(pane, active ? "blocked" : "working", label)
          .pipe(Effect.catch((e) => log("report_blocked", { pane, error: e.message }))),
    };
  });

export const claudeParent = (pane: string): Layer.Layer<ParentHarness, never, Herdr> =>
  Layer.effect(ParentHarness, makeClaudeParent(pane));
