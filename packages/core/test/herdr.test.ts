import { execFile } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import { vi } from "vitest";
import { client } from "../src/herdr.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("herdr command boundary", () => {
  it.effect("falls back once to the visible screen only for agent_not_idle and preserves the machine", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const logs: Array<{ stage: unknown; error: unknown }> = [];
      vi.mocked(execFile).mockImplementation(((_bin: string, args: string[], _opts: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
        calls.push(args);
        if (args.includes("recent-unwrapped")) {
          done(new Error("failed"), "", JSON.stringify({ error: { code: "agent_not_idle", message: "still working" } }));
        } else {
          done(null, "live screen", "");
        }
      }) as any);
      const h = client({ id: "box-id", label: "box", target: "user@box" });
      const result = yield* h.agentRead("child", 40).pipe(Effect.provide(Logger.layer([Logger.make(({ message, fiber }) => {
        logs.push({ stage: Array.isArray(message) ? message.join(" ") : message, error: fiber.getRef(References.CurrentLogAnnotations).error });
      })])));
      expect(result).toBe("live screen");
      expect(calls).toEqual([
        ["--machine", "box-id", "agent", "read", "child", "--source", "recent-unwrapped", "--lines", "40"],
        ["--machine", "box-id", "agent", "read", "child", "--source", "visible", "--lines", "40"],
      ]);
      expect(logs.map((l) => l.stage)).toEqual(["herdr:agent_read", "herdr:agent_read", "herdr:agent_read"]);
      expect(logs[1].error).toBe("still working");
    }),
  );

  it.effect("logs the length of a sent message, never its text", () =>
    Effect.gen(function* () {
      const logs: Array<Record<string, unknown>> = [];
      vi.mocked(execFile).mockImplementation(((_bin: string, _args: string[], _opts: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
        done(null, JSON.stringify({ result: { agent: { agent_id: "child", status: "idle" } } }), "");
      }) as any);
      const h = client();
      const secret = "the pilot is job 6767509";
      yield* Effect.all([h.agentPrompt("child", secret), h.agentPromptWait("child", secret).pipe(Effect.ignore), h.paneRun("p1", secret)]).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message, fiber }) => {
          logs.push({ stage: Array.isArray(message) ? message.join(" ") : message, ...fiber.getRef(References.CurrentLogAnnotations) });
        })])),
      );
      expect(logs.map(({ stage, args, textLen }) => ({ stage, args, textLen }))).toEqual([
        { stage: "herdr:agent_prompt", args: ["child"], textLen: secret.length },
        { stage: "herdr:agent_prompt", args: ["child", "--wait"], textLen: secret.length },
        { stage: "herdr:pane_run", args: ["p1"], textLen: secret.length },
      ]);
      expect(JSON.stringify(logs)).not.toContain("6767509");
    }),
  );

  it.effect("does not retry unrelated read errors or a failed visible fallback", () =>
    Effect.gen(function* () {
      for (const code of ["agent_not_found", "agent_not_idle"]) {
        let calls = 0;
        vi.mocked(execFile).mockImplementation(((_bin: string, _args: string[], _opts: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
          calls++;
          done(new Error("failed"), "", JSON.stringify({ error: { code, message: "read failed" } }));
        }) as any);
        const error = yield* Effect.flip(client().agentRead("child", 30));
        expect(error.code).toBe(code);
        expect(calls).toBe(code === "agent_not_idle" ? 2 : 1);
      }
    }),
  );
});
