/**
 * Claude Code parent harness. Claude has no extension API, so reports are
 * typed into this session's own pane through herdr (they arrive as a user
 * message) and the blocked state is reported to herdr directly.
 */
import { h as defaultHerdr, type Herdr, HerdrError, log, type ParentHarness } from "@herdr-agents/core";

export function createClaudeParent(pane: string, h: Herdr = defaultHerdr): ParentHarness {
  return {
    harness: "claude",
    // notify is ignored: typing into the pane always triggers a turn.
    deliver(report) {
      // It lands as a user message, so say who really wrote it.
      const text = `[herdr-agents delivery: agent output, not typed by the user]\n${report}`;
      void h.agentPrompt(pane, text).catch(async (e) => {
        if (!(e instanceof HerdrError && e.code === "agent_blocked")) {
          log("deliver_failed", { pane, error: String(e) });
          return;
        }
        await h
          .paneRun(pane, text)
          .catch((e2) => log("deliver_failed", { pane, error: String(e2) }));
      });
    },
    setBlocked(active, label) {
      // ponytail: herdr's screen manifest is the state authority for claude;
      // this report is best effort and may be overridden on the next redraw.
      void h
        .paneReportAgent(pane, active ? "blocked" : "working", label)
        .catch((e) => log("report_blocked", { pane, error: String(e) }));
    },
  };
}
