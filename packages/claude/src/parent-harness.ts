/**
 * Claude Code parent harness. Claude has no extension API, so reports are
 * typed into this session's own pane through herdr (they arrive as a user
 * message) and the blocked state is reported to herdr directly.
 */
import { Herdr, isHerdrCode, log, ParentHarness, type ParentHarnessShape } from "@herdr-agents/core";
import { Effect, Layer } from "effect";

const blocked = (e: unknown) => isHerdrCode(e, "agent_blocked");

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
        const prompt = h.agentPrompt(pane, text);
        return prompt.pipe(
          // This session's own expect_reply report: the Delivery starts a turn anyway.
          Effect.catchIf(blocked, () => h.paneReleaseAgent(pane).pipe(Effect.andThen(prompt))),
          // A dialog is on screen and typing would answer it: wait until someone has.
          Effect.catchIf(blocked, () =>
            log("deliver_wait", { pane }).pipe(
              Effect.andThen(h.agentWaitUntil(pane, ["idle", "done", "working"])),
              Effect.andThen(prompt),
            ),
          ),
          Effect.catch((e) => log("deliver_failed", { pane, error: e.message })),
        );
      },
      // herdr never clears a reported blocked state on its own: a self-report
      // beats screen detection. The reply's SendMessage releases it
      // (Manager.send), and so does a Delivery into this pane.
      // ponytail: a reply a person types into the pane leaves it blocked until
      // the next SendMessage or Delivery; watch the session file if that bites.
      setBlocked: (active, label) =>
        (active ? h.paneReportAgent(pane, "blocked", label) : h.paneReleaseAgent(pane)).pipe(
          Effect.catch((e) => log("report_blocked", { pane, error: e.message })),
        ),
    };
  });

export const claudeParent = (pane: string): Layer.Layer<ParentHarness, never, Herdr> =>
  Layer.effect(ParentHarness, makeClaudeParent(pane));
