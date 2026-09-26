/**
 * parent-harness.ts: what the parent harness must provide. The pi extension
 * and the Claude MCP server are the two implementations.
 */
import { Context, type Effect } from "effect";

export type Harness = "pi" | "claude";

export const HARNESSES: Harness[] = ["pi", "claude"];

export interface ParentHarnessShape {
  readonly harness: Harness;
  /** The parent session's cwd, read per call so project config is live. */
  cwd(): string;
  /** Parent defaults, applied only to children of the same harness. */
  model?(): string | undefined;
  thinking?(): string | undefined;
  /** Put text in front of the parent conversation. */
  deliver(text: string, notify: "follow_up" | "passive"): Effect.Effect<void>;
  /**
   * True while the parent runs a turn. The Manager then holds Deliveries until
   * the parent harness calls `Manager.flush`, so a Report the parent reads
   * meanwhile is not delivered a second time.
   */
  busy?(): boolean;
  /** Mark this session blocked (waiting for the parent) in herdr. */
  setBlocked(active: boolean, label?: string): Effect.Effect<void>;
}

export class ParentHarness extends Context.Service<ParentHarness, ParentHarnessShape>()(
  "herdr-agents/ParentHarness",
) {}
