/**
 * parent-harness.ts: what the parent harness must provide. The pi extension
 * and the Claude MCP server are the two implementations.
 */
export type Harness = "pi" | "claude";

export const HARNESSES: Harness[] = ["pi", "claude"];

export interface ParentHarness {
  harness: Harness;
  /** Parent defaults, applied only to children of the same harness. */
  model?: () => string | undefined;
  thinking?: () => string | undefined;
  /** Put text in front of the parent conversation. */
  deliver(text: string, notify: "follow_up" | "passive"): void;
  /** Mark this session blocked (waiting for the parent) in herdr. */
  setBlocked(active: boolean, label?: string): void;
}
