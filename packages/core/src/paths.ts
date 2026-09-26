/**
 * paths.ts: pi's and Claude Code's config locations, reimplemented so the
 * core never imports pi's runtime (the Claude parent harness runs without it).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "effect";
import { parse } from "yaml";

export const CONFIG_DIR_NAME = ".pi";

const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, homedir());

/** pi's agent dir: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export const agentDir: Config.Config<string> = Config.String("PI_CODING_AGENT_DIR").pipe(
  Config.map(expandHome),
  Config.withDefault(join(homedir(), CONFIG_DIR_NAME, "agent")),
);

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeDir: Config.Config<string> = Config.String("CLAUDE_CONFIG_DIR").pipe(
  Config.withDefault(join(homedir(), ".claude")),
);

export function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): { frontmatter: T; body: string } {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return { frontmatter: {} as T, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {} as T, body: text };
  const fm = (parse(text.slice(3, end)) ?? {}) as T;
  const body = text.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: fm, body };
}
