/**
 * herdr.ts: the `herdr` CLI as a service. Every command prints JSON on stdout
 * (success) or JSON on stderr (error). Responses are decoded, so a herdr
 * change fails loudly at this boundary instead of as `undefined` further in.
 *
 * A Machine child lives on another herdr server. Every command for it is
 * prefixed with `--machine <id>`, which herdr forwards over its SSH API
 * bridge. The one thing herdr cannot forward is a file read, so the session
 * file of a Machine child is fetched with `ssh <target> cat`.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Context, Data, Effect, Layer, Schedule, Schema } from "effect";
import { log } from "./log.ts";

/** Codes the manager branches on. herdr adds codes over time, so the set stays open. */
export type HerdrCode =
  | "agent_pane_busy"
  | "agent_not_ready"
  | "agent_blocked"
  | "agent_prompt_stalled"
  | "workspace_not_found"
  | "timeout";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly code?: HerdrCode | (string & {});
}> {}

export const isHerdrCode = (e: unknown, code: HerdrCode): boolean =>
  e instanceof HerdrError && e.code === code;

/** herdr's own agent states. */
export const HERDR_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type HerdrStatus = (typeof HERDR_STATUSES)[number];

export interface AgentInfo {
  status: HerdrStatus;
  pane: string;
  name?: string;
  /** pi reports a path, Claude Code reports an id. */
  sessionPath?: string;
  sessionId?: string;
  /** Harness herdr detected in the pane, e.g. pi, claude, codex. */
  harness?: string;
  cwd?: string;
}

/** One row of `herdr machine list --json`. */
export interface Machine {
  id: string;
  label: string;
  /** SSH destination as saved by `herdr machine add`. */
  target: string;
  /** Disabled machines are skipped when listing agents. */
  enabled?: boolean;
}

const Str = Schema.optionalKey(Schema.NullOr(Schema.String));

const AgentJson = Schema.Struct({
  pane_id: Schema.String,
  agent_status: Schema.String,
  name: Str,
  agent: Str,
  cwd: Str,
  agent_session: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ kind: Schema.String, value: Schema.String })),
  ),
});

const AgentResult = Schema.Struct({ agent: AgentJson });
const AgentListResult = Schema.Struct({ agents: Schema.Array(AgentJson) });
const MachineRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    target: Schema.String,
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
);
const TabResult = Schema.Struct({
  root_pane: Schema.Struct({ pane_id: Schema.String, cwd: Str }),
});
const WorkspaceResult = Schema.Struct({
  workspace: Schema.Struct({ workspace_id: Schema.String, label: Schema.String }),
});
const WorkspaceListResult = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ workspace_id: Schema.String, label: Schema.String })),
});

const isStatus = (s: string): s is HerdrStatus => (HERDR_STATUSES as readonly string[]).includes(s);

const toAgentInfo = (a: typeof AgentJson.Type): AgentInfo => ({
  status: isStatus(a.agent_status) ? a.agent_status : "unknown",
  pane: a.pane_id,
  name: a.name ?? undefined,
  harness: a.agent ?? undefined,
  cwd: a.cwd ?? undefined,
  sessionPath: a.agent_session?.kind === "path" ? a.agent_session.value : undefined,
  sessionId: a.agent_session?.kind === "id" ? a.agent_session.value : undefined,
});

const tryJson = (s: string): any => {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
};

/** Run a command, fail with the message herdr printed. Interruption kills the process. */
const run = (bin: string, args: string[], stage: string, machine?: string): Effect.Effect<string, HerdrError> =>
  Effect.callback<string, HerdrError>((resume, signal) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (!err) return resume(Effect.succeed(stdout));
      if (signal.aborted) return;
      const parsed = tryJson(stderr);
      const code = parsed?.error?.code ?? parsed?.code;
      const msg = parsed?.error?.message ?? parsed?.message ?? (stderr.trim() || err.message);
      resume(
        log(stage, { error: msg, code, machine }).pipe(
          Effect.andThen(Effect.fail(new HerdrError({ message: `${stage} failed: ${msg}`, code }))),
        ),
      );
    });
  });

/** Raw stdout of a herdr command. Logs the call first, without the text it sends. */
const herdrRaw = (args: string[], machine?: string): Effect.Effect<string, HerdrError> => {
  const stage = args.slice(0, 2).join(" ");
  return log(`herdr:${stage.replace(" ", "_")}`, { args: args.slice(2, 6), machine }).pipe(
    Effect.andThen(run("herdr", [...(machine ? ["--machine", machine] : []), ...args], stage, machine)),
  );
};

/** Run a herdr command and return `.result` of its JSON response, decoded. */
const herdr = <A>(args: string[], schema: Schema.Decoder<A>, machine?: string): Effect.Effect<A, HerdrError> => {
  const stage = args.slice(0, 2).join(" ");
  return herdrRaw(args, machine).pipe(
    Effect.flatMap((stdout) => {
      const parsed = tryJson(stdout);
      if (stdout.trim() && parsed === undefined)
        return Effect.fail(new HerdrError({ message: `${stage}: non-JSON output: ${stdout.slice(0, 200)}` }));
      return Schema.decodeUnknownEffect(schema)(parsed?.result ?? parsed).pipe(
        Effect.mapError(
          (e) => new HerdrError({ message: `${stage}: unexpected response: ${e.message}`, code: "invalid_response" }),
        ),
      );
    }),
  );
};

const envArgs = (env: Record<string, string>): string[] =>
  Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

/** Quote for a remote POSIX shell. A leading `~/` stays unquoted so ssh expands it. */
const shellQuote = (path: string): string => {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return path.startsWith("~/") ? `~/${q(path.slice(2))}` : q(path);
};

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export interface HerdrClient {
  /** Same helpers against a saved machine. */
  machine(target: Machine): HerdrClient;
  machineList(): Effect.Effect<Machine[], HerdrError>;
  /** Session file contents, local or over ssh. */
  readFile(path: string): Effect.Effect<string, HerdrError>;
  /** Copy a local staging dir to `as` on the machine (`as` must sit in an existing dir). */
  stage(dir: string, as: string): Effect.Effect<void, HerdrError>;
  unstage(dir: string): Effect.Effect<void>;
  /** Returns the new pane id and the cwd herdr gave it (herdr falls back to $HOME silently). */
  tabCreate(
    label: string,
    cwd: string,
    env: Record<string, string>,
    workspace?: string,
  ): Effect.Effect<{ pane: string; cwd: string }, HerdrError>;
  workspaceLabel(id: string): Effect.Effect<string, HerdrError>;
  /** Workspace id for `label`, first match, created when missing. */
  workspaceByLabel(label: string, cwd: string): Effect.Effect<string, HerdrError>;
  /** Retries while the freshly created pane's shell is still booting. */
  agentStart(id: string, pane: string, kind: string, agentArgs: string[]): Effect.Effect<void, HerdrError>;
  agentPrompt(id: string, text: string): Effect.Effect<void, HerdrError>;
  /** Prompt then block until idle | done | blocked. */
  agentPromptWait(id: string, text: string): Effect.Effect<AgentInfo, HerdrError>;
  /** Blocks until idle | done | blocked. */
  agentWait(id: string): Effect.Effect<AgentInfo, HerdrError>;
  /** Block until the agent reaches one of the given states. */
  agentWaitUntil(id: string, states: HerdrStatus[]): Effect.Effect<AgentInfo, HerdrError>;
  agentGet(id: string): Effect.Effect<AgentInfo, HerdrError>;
  agentList(): Effect.Effect<AgentInfo[], HerdrError>;
  agentRead(id: string, lines: number): Effect.Effect<string, HerdrError>;
  /** Screen of a pane no agent is registered in, e.g. after a failed start. */
  paneRead(pane: string, lines: number): Effect.Effect<string, HerdrError>;
  agentFocus(id: string): Effect.Effect<void, HerdrError>;
  sendKeys(id: string, keys: string[]): Effect.Effect<void, HerdrError>;
  paneRun(pane: string, text: string): Effect.Effect<void, HerdrError>;
  /** Report a lifecycle state for a pane whose harness cannot report it itself. */
  paneReportAgent(pane: string, state: "idle" | "working" | "blocked", message?: string): Effect.Effect<void, HerdrError>;
  paneClose(pane: string): Effect.Effect<void, HerdrError>;
}

/** The live client, local or bound to a saved machine. */
export function client(machine?: Machine): HerdrClient {
  const m = machine?.id;
  const call = <A>(args: string[], schema: Schema.Decoder<A>) => herdr(args, schema, m);
  const done = (args: string[]) => call(args, Schema.Unknown).pipe(Effect.asVoid);
  const agent = (args: string[]) => call(args, AgentResult).pipe(Effect.map((r) => toAgentInfo(r.agent)));
  return {
    machine: (target) => client(target),
    machineList: () =>
      herdr(["machine", "list", "--json"], Schema.NullOr(MachineRows)).pipe(
        Effect.map((rows) => (rows ?? []).map((x) => ({ id: x.id, label: x.label, target: x.target, enabled: x.enabled }))),
      ),
    readFile: (path) =>
      machine
        ? run("ssh", [...SSH, machine.target, `cat ${shellQuote(path)}`], "ssh cat", m)
        : Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: (e) => new HerdrError({ message: `read ${path} failed: ${String(e)}` }),
          }),
    stage: (dir, as) =>
      !machine || as === dir
        ? Effect.void
        : run("scp", [...SSH, "-q", "-r", dir, `${machine.target}:${as}`], "scp", m).pipe(Effect.asVoid),
    unstage: (dir) =>
      !machine
        ? Effect.void
        : run("ssh", ["-o", "BatchMode=yes", machine.target, `rm -rf ${shellQuote(dir)}`], "ssh rm", m).pipe(
            Effect.asVoid,
            Effect.catch((e) => log("unstage", { dir, error: e.message })),
          ),
    tabCreate: (label, cwd, env, workspace) =>
      call(
        [
          "tab",
          "create",
          "--no-focus",
          "--label",
          label,
          "--cwd",
          cwd,
          ...(workspace ? ["--workspace", workspace] : []),
          ...envArgs(env),
        ],
        TabResult,
      ).pipe(Effect.map((r) => ({ pane: r.root_pane.pane_id, cwd: r.root_pane.cwd ?? cwd }))),
    workspaceLabel: (id) => call(["workspace", "get", id], WorkspaceResult).pipe(Effect.map((r) => r.workspace.label)),
    workspaceByLabel: (label, cwd) =>
      call(["workspace", "list"], WorkspaceListResult).pipe(
        Effect.flatMap((r) => {
          const found = r.workspaces.find((w) => w.label === label);
          if (found) return Effect.succeed(found.workspace_id);
          return call(["workspace", "create", "--no-focus", "--label", label, "--cwd", cwd], WorkspaceResult).pipe(
            Effect.map((c) => c.workspace.workspace_id),
          );
        }),
      ),
    agentStart: (id, pane, kind, agentArgs) =>
      done(["agent", "start", id, "--kind", kind, "--pane", pane, "--timeout", "120000", "--", ...agentArgs]).pipe(
        Effect.retry({
          schedule: Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: "15 seconds" })),
          while: (e) => e.code === "agent_pane_busy",
        }),
      ),
    agentPrompt: (id, text) => done(["agent", "prompt", id, text]),
    agentPromptWait: (id, text) => agent(["agent", "prompt", id, text, "--wait"]),
    agentWait: (id) => agent(["agent", "wait", id]),
    agentWaitUntil: (id, states) => agent(["agent", "wait", id, ...states.flatMap((s) => ["--until", s])]),
    agentGet: (id) => agent(["agent", "get", id]),
    agentList: () => call(["agent", "list"], AgentListResult).pipe(Effect.map((r) => r.agents.map(toAgentInfo))),
    agentRead: (id, lines) =>
      herdrRaw(["agent", "read", id, "--source", "recent-unwrapped", "--lines", String(lines)], m),
    paneRead: (pane, lines) =>
      herdrRaw(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)], m),
    agentFocus: (id) => done(["agent", "focus", id]),
    sendKeys: (id, keys) => done(["agent", "send-keys", id, ...keys]),
    paneRun: (pane, text) => done(["pane", "run", pane, text]),
    paneReportAgent: (pane, state, message) =>
      done([
        "pane",
        "report-agent",
        pane,
        "--source",
        "herdr-agents",
        "--agent",
        "claude",
        "--state",
        state,
        ...(message ? ["--message", message] : []),
      ]),
    paneClose: (pane) => done(["pane", "close", pane]),
  };
}

export class Herdr extends Context.Service<Herdr, HerdrClient>()("herdr-agents/Herdr") {
  static readonly layer = Layer.sync(Herdr, () => client());
}
