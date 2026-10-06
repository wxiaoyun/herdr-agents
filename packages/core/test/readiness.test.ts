import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { type AgentInfo, HerdrError } from "../src/herdr.ts";
import { base, deliveries, emptyHerdr, manager } from "./helpers.ts";

const idle: AgentInfo = { status: "idle", pane: "w1:p9" };
const ready: AgentInfo = { ...idle, sessionPath: "/test/session.jsonl" };
const stalled = () => Effect.fail(new HerdrError({ code: "agent_prompt_stalled", message: "no observed working state" }));

describe("pi readiness and uncertain delivery", () => {
  it.effect("waits for the session before sending the first prompt exactly once", () =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<void>();
      let polls = 0;
      let prompts = 0;
      const m = yield* manager({ herdr: {
        ...emptyHerdr(),
        agentGet: () => Effect.sync(() => ++polls >= 3 ? ready : idle).pipe(Effect.tap(() => Deferred.succeed(pending, undefined))),
        agentPromptWait: () => Effect.sync(() => { prompts++; return ready; }),
      } });
      const spawn = yield* Effect.forkChild(m.spawn(base));
      yield* Deferred.await(pending);
      expect(prompts).toBe(0);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(spawn)).status).toBe("idle");
      expect(prompts).toBe(1);
    }),
  );

  it.effect("times out without sending a task or closing the idle pane", () =>
    Effect.gen(function* () {
      let prompts = 0;
      let closes = 0;
      const m = yield* manager({ herdr: {
        ...emptyHerdr(),
        agentGet: () => Effect.succeed(idle),
        agentPromptWait: () => Effect.sync(() => { prompts++; return ready; }),
        paneClose: () => Effect.sync(() => { closes++; }),
      } });
      const spawn = yield* Effect.forkChild(Effect.flip(m.spawn(base)));
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(spawn)).message).toContain("Task prompt was not sent");
      expect(m.list()[0].status).toBe("idle");
      expect(prompts).toBe(0);
      expect(closes).toBe(0);
    }),
  );

  it.effect("does not type into a startup dialog while waiting for a pi session", () =>
    Effect.gen(function* () {
      for (const sessionPath of [undefined, ready.sessionPath]) {
        const answered = yield* Deferred.make<AgentInfo>();
        const out = yield* deliveries;
        let readyNow = false;
        let prompts = 0;
        const m = yield* manager({ parent: { deliver: out.deliver }, herdr: {
          ...emptyHerdr(),
          agentGet: () => Effect.succeed(readyNow ? ready : { ...idle, status: "blocked", sessionPath }),
          agentWaitUntil: () => Deferred.await(answered),
          agentPromptWait: () => Effect.sync(() => { prompts++; return ready; }),
        } });
        expect((yield* m.spawn({ ...base, background: true })).status).toBe("blocked");
        yield* TestClock.adjust("1 minute");
        expect(prompts).toBe(0);
        readyNow = true;
        yield* Deferred.succeed(answered, ready);
        yield* out.next;
        expect(prompts).toBe(1);
      }
    }),
  );

  it.effect("keeps an unobservable stalled child unknown without resend, relaunch, or close", () =>
    Effect.gen(function* () {
      let reachable = true;
      let prompts = 0;
      let starts = 0;
      let closes = 0;
      const m = yield* manager({ herdr: {
        ...emptyHerdr(),
        agentStart: () => Effect.sync(() => { starts++; }),
        agentGet: () => reachable ? Effect.succeed(ready) : Effect.fail(new HerdrError({ message: "API unavailable" })),
        agentPromptWait: () => Effect.sync(() => { prompts++; reachable = false; }).pipe(Effect.andThen(stalled())),
        paneClose: () => Effect.sync(() => { closes++; }),
      } });
      const error = yield* Effect.flip(m.spawn(base));
      expect(error.message).toContain("Prompt delivery is unknown");
      const child = m.list()[0];
      expect(child.status).toBe("unknown");
      expect(child.slot).toBe(true);
      expect((yield* Effect.flip(m.spawn({ ...base, resume: child.id }))).message).toContain("cannot be observed");
      expect([prompts, starts, closes]).toEqual([1, 1, 0]);
    }),
  );

  it.effect("preserves a live working child after an uncertain wait without sending again", () =>
    Effect.gen(function* () {
      let working = false;
      let prompts = 0;
      const m = yield* manager({ herdr: {
        ...emptyHerdr(),
        agentGet: () => Effect.succeed(working ? { ...ready, status: "working" } : ready),
        readFile: () => Effect.fail(new HerdrError({ message: "session unavailable" })),
        agentPromptWait: () => Effect.sync(() => { prompts++; working = true; }).pipe(Effect.andThen(stalled())),
      } });
      expect((yield* Effect.flip(m.spawn(base))).message).toContain("Prompt delivery is unknown");
      const child = m.list()[0];
      expect(child.status).toBe("running");
      expect(child.slot).toBe(true);
      expect((yield* Effect.flip(m.spawn({ ...base, resume: child.id }))).message).toContain("only an idle child");
      expect(prompts).toBe(1);
    }),
  );

  it.effect("logs herdr's last status and UTF-8 session size separately from child status", () => {
    const logs: Array<Record<string, unknown>> = [];
    return Effect.gen(function* () {
      let prompts = 0;
      const raw = "界";
      const m = yield* manager({ herdr: {
        ...emptyHerdr(),
        agentGet: () => Effect.succeed(ready),
        readFile: () => Effect.succeed(raw),
        agentPromptWait: () => Effect.sync(() => { prompts++; }).pipe(Effect.andThen(stalled())),
      } });
      const spawn = yield* Effect.forkChild(Effect.flip(m.spawn(base)));
      yield* TestClock.adjust("31 seconds");
      yield* Fiber.join(spawn);
      expect(logs).toEqual([{ id: "pi-general-purpose-1", herdr_status: "idle", child_status: "running", session_bytes: 3 }]);
      expect(m.list()[0].status).toBe("idle");
      expect(prompts).toBe(1);
    }).pipe(Effect.provide(Logger.layer([Logger.make(({ message, fiber }) => {
      if (String(message) === "prompt_wait_stall_timeout") logs.push(fiber.getRef(References.CurrentLogAnnotations));
    })])));
  });
});
