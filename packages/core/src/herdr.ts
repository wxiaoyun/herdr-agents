/**
 * herdr.ts: thin wrapper over the `herdr` CLI. Every command prints JSON on
 * stdout (success) or JSON on stderr (error). Optional file logging makes a
 * broken step searchable by stage without corrupting the TUI streams.
 *
 * A Machine child lives on another herdr server. Every command for it is
 * prefixed with `--machine <id>`, which herdr forwards over its SSH API
 * bridge. The one thing herdr cannot forward is a file read, so the session
 * file of a Machine child is fetched with `ssh <target> cat`.
 */
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./paths.ts";

export const LOG_ENV = "HERDR_AGENTS_LOG";

export const log = (
  stage: string,
  fields: Record<string, unknown> = {},
): void => {
  const configuredPath = process.env[LOG_ENV];
  if (!configuredPath) return;
  const path =
    configuredPath === "1"
      ? join(getAgentDir(), "herdr-agents-debug.log")
      : configuredPath;
  try {
    const kv = Object.entries(fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[herdr-agents] stage=${stage} ${kv}\n`);
  } catch {
    // Logging must never write to the TUI streams or break extension behavior.
  }
};

export class HerdrError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return raw stdout instead of parsing JSON. */
  raw?: boolean;
  /** Saved herdr machine profile id; the command runs on that server. */
  machine?: string;
}

function run(
  bin: string,
  args: string[],
  stage: string,
  opts: ExecOpts,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeoutMs,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          const parsed = tryJson(stderr);
          const code = parsed?.error?.code ?? parsed?.code;
          const msg =
            parsed?.error?.message ??
            parsed?.message ??
            stderr.trim() ??
            err.message;
          log(stage, { error: msg, code, machine: opts.machine });
          reject(new HerdrError(`${stage} failed: ${msg}`, code));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Run a herdr command and return `.result` of its JSON response. */
export async function herdr(args: string[], opts: ExecOpts = {}): Promise<any> {
  const stage = args.slice(0, 2).join(" ");
  log(`herdr:${stage.replace(" ", "_")}`, {
    args: args.slice(2, 6),
    machine: opts.machine,
  });
  const prefix = opts.machine ? ["--machine", opts.machine] : [];
  const stdout = await run("herdr", [...prefix, ...args], stage, opts);
  if (opts.raw) return stdout;
  if (!stdout.trim()) return undefined;
  const parsed = tryJson(stdout);
  if (!parsed)
    throw new HerdrError(`${stage}: non-JSON output: ${stdout.slice(0, 200)}`);
  return parsed.result ?? parsed;
}

function tryJson(s: string): any | undefined {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

const envArgs = (env: Record<string, string>): string[] =>
  Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export interface AgentInfo {
  status: string;
  pane: string;
  name?: string;
  /** pi reports a path, Claude Code reports an id. */
  sessionPath?: string;
  sessionId?: string;
  /** Harness herdr detected in the pane, e.g. pi, claude, codex. */
  harness?: string;
  cwd?: string;
}

const toAgentInfo = (a: any): AgentInfo => ({
  status: a.agent_status ?? "unknown",
  pane: a.pane_id,
  name: a.name ?? undefined,
  harness: a.agent,
  cwd: a.cwd,
  sessionPath:
    a.agent_session?.kind === "path" ? a.agent_session.value : undefined,
  sessionId: a.agent_session?.kind === "id" ? a.agent_session.value : undefined,
});

/** One row of `herdr machine list --json`. */
export interface Machine {
  id: string;
  label: string;
  /** SSH destination as saved by `herdr machine add`. */
  target: string;
  /** Disabled machines are skipped when listing agents. */
  enabled?: boolean;
}

/** Quote for a remote POSIX shell. A leading `~/` stays unquoted so ssh expands it. */
const shellQuote = (path: string): string => {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return path.startsWith("~/") ? `~/${q(path.slice(2))}` : q(path);
};

/** Named helpers used by the manager. `bind(machine)` targets another server. Injectable for tests. */
export function bind(machine?: Machine) {
  const m = machine?.id;
  const call = (args: string[], opts: ExecOpts = {}) =>
    herdr(args, { ...opts, machine: m });
  return {
    /** Same helpers against a saved machine. */
    machine: (target: Machine) => bind(target),
    async machineList(): Promise<Machine[]> {
      const r = await herdr(["machine", "list", "--json"]);
      return (Array.isArray(r) ? r : []).map((x: any) => ({
        id: x.id,
        label: x.label,
        target: x.target,
        enabled: x.enabled,
      }));
    },
    /** Saved machine labels, read once at startup for the tool description. Local, no ssh. */
    machineLabels(): string[] {
      try {
        const out = execFileSync("herdr", ["machine", "list", "--json"], {
          timeout: 5000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const r = JSON.parse(out);
        return (Array.isArray(r) ? r : []).map((x: any) => x.label).filter(Boolean);
      } catch (e) {
        log("machine_labels", { error: String(e) });
        return [];
      }
    },
    /** Session file contents, local or over ssh. */
    async readFile(path: string): Promise<string> {
      if (!machine) return readFileSync(path, "utf8");
      return run(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          machine.target,
          `cat ${shellQuote(path)}`,
        ],
        "ssh cat",
        { machine: m },
      );
    },
    /** Copy a local staging dir to `as` on the machine (`as` must sit in an existing dir). */
    async stage(dir: string, as: string): Promise<void> {
      if (!machine || as === dir) return;
      await run(
        "scp",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-q", "-r", dir, `${machine.target}:${as}`],
        "scp",
        { machine: m },
      );
    },
    async unstage(dir: string): Promise<void> {
      if (!machine) return;
      await run("ssh", ["-o", "BatchMode=yes", machine.target, `rm -rf ${shellQuote(dir)}`], "ssh rm", { machine: m }).catch((e) =>
        log("unstage", { dir, error: String(e) }),
      );
    },
    /** Returns the new pane id and the cwd herdr gave it (herdr falls back to $HOME silently). */
    async tabCreate(
      label: string,
      cwd: string,
      env: Record<string, string>,
      workspace?: string,
    ): Promise<{ pane: string; cwd: string }> {
      const r = await call([
        "tab",
        "create",
        "--no-focus",
        "--label",
        label,
        "--cwd",
        cwd,
        ...(workspace ? ["--workspace", workspace] : []),
        ...envArgs(env),
      ]);
      return { pane: r.root_pane.pane_id, cwd: r.root_pane.cwd ?? cwd };
    },
    async workspaceLabel(id: string): Promise<string> {
      const r = await call(["workspace", "get", id]);
      return r.workspace.label;
    },
    /** Workspace id for `label`, first match, created when missing. */
    async workspaceByLabel(label: string, cwd: string): Promise<string> {
      const r = await call(["workspace", "list"]);
      const found = (r.workspaces ?? []).find((w: any) => w.label === label);
      if (found) return found.workspace_id;
      const c = await call([
        "workspace",
        "create",
        "--no-focus",
        "--label",
        label,
        "--cwd",
        cwd,
      ]);
      return c.workspace.workspace_id;
    },
    /** Retries while the freshly created pane's shell is still booting. */
    async agentStart(
      id: string,
      pane: string,
      kind: string,
      agentArgs: string[],
      timeoutMs = 120000,
    ): Promise<void> {
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          await call([
            "agent",
            "start",
            id,
            "--kind",
            kind,
            "--pane",
            pane,
            "--timeout",
            String(timeoutMs),
            "--",
            ...agentArgs,
          ]);
          return;
        } catch (e) {
          if (
            !(e instanceof HerdrError && e.code === "agent_pane_busy") ||
            Date.now() > deadline
          )
            throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    },
    async agentPrompt(id: string, text: string): Promise<void> {
      await call(["agent", "prompt", id, text]);
    },
    /** Prompt then block until idle | done | blocked. */
    async agentPromptWait(
      id: string,
      text: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<AgentInfo> {
      const args = ["agent", "prompt", id, text, "--wait"];
      if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
      const r = await call(args, { signal });
      return toAgentInfo(r.agent);
    },
    /** Blocks until idle | done | blocked. */
    async agentWait(
      id: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<AgentInfo> {
      const args = ["agent", "wait", id];
      if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
      const r = await call(args, { signal });
      return toAgentInfo(r.agent);
    },
    /** Block until the agent reaches one of the given states. */
    async agentWaitUntil(
      id: string,
      states: string[],
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<AgentInfo> {
      const args = [
        "agent",
        "wait",
        id,
        ...states.flatMap((s) => ["--until", s]),
      ];
      if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
      const r = await call(args, { signal });
      return toAgentInfo(r.agent);
    },
    async agentGet(id: string): Promise<AgentInfo> {
      const r = await call(["agent", "get", id]);
      return toAgentInfo(r.agent);
    },
    async agentList(): Promise<AgentInfo[]> {
      const r = await call(["agent", "list"]);
      return (r.agents ?? []).map(toAgentInfo);
    },
    async agentRead(id: string, lines: number): Promise<string> {
      return call(
        [
          "agent",
          "read",
          id,
          "--source",
          "recent-unwrapped",
          "--lines",
          String(lines),
        ],
        { raw: true },
      );
    },
    /** Screen of a pane no agent is registered in, e.g. after a failed start. */
    async paneRead(pane: string, lines: number): Promise<string> {
      return call(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)], { raw: true });
    },
    async agentFocus(id: string): Promise<void> {
      await call(["agent", "focus", id]);
    },
    async sendKeys(id: string, keys: string[]): Promise<void> {
      await call(["agent", "send-keys", id, ...keys]);
    },
    async paneRun(pane: string, text: string): Promise<void> {
      await call(["pane", "run", pane, text]);
    },
    /** Report a lifecycle state for a pane whose harness cannot report it itself. */
    async paneReportAgent(
      pane: string,
      state: "idle" | "working" | "blocked",
      message?: string,
    ): Promise<void> {
      const args = [
        "pane",
        "report-agent",
        pane,
        "--source",
        "herdr-agents",
        "--agent",
        "claude",
        "--state",
        state,
      ];
      if (message) args.push("--message", message);
      await call(args);
    },
    async paneClose(pane: string): Promise<void> {
      await call(["pane", "close", pane]);
    },
  };
}

export type Herdr = ReturnType<typeof bind>;
export const h: Herdr = bind();
