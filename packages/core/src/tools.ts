/**
 * tools.ts: the five tools, harness-neutral. Each parent harness wraps them in its own
 * registration API (pi registerTool, MCP tools/list + tools/call).
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import { Config, Context, Effect, Layer, ManagedRuntime, Schema, type Scope } from "effect";
import { Herdr } from "./herdr.ts";
import { FileLogger, log } from "./log.ts";
import { ENV_DEPTH, ENV_ID, ENV_PARENT, ENV_PROFILE, Manager } from "./manager.ts";
import { type Harness, ParentHarness } from "./parent-harness.ts";
import { agentDir } from "./paths.ts";
import { loadProfiles } from "./profiles.ts";
import { CurrentSettings } from "./settings.ts";

export interface ToolResult {
  text: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

/**
 * A tool as the core runs it. `parameters` is the JSON Schema of its
 * arguments. `run` decodes them first. `abort` completing means the caller
 * stopped waiting.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(params: unknown, abort?: Effect.Effect<void>): Effect.Effect<ToolResult>;
}

/**
 * Default cwd for a Machine child: the parent's cwd relative to the local
 * home, which herdr resolves against the remote home. Mirrored checkouts
 * line up without config. Outside the home the path is kept as is.
 */
export function machineCwd(dir: string, home = homedir()): string {
  const rel = relative(home, dir);
  if (rel === "") return "~";
  return rel.startsWith("..") || rel.startsWith("/") ? dir : rel;
}

const ok = (text: string, details?: Record<string, unknown>): ToolResult => ({
  text,
  details,
});
const err = (text: string): ToolResult => ({ text, isError: true });

const d = (description: string) => ({ description });

const AgentParams = Schema.Struct({
  prompt: Schema.String.annotate(d("Task for the child. Self-contained, the child has no conversation context.")),
  description: Schema.String.annotate(d("3-5 word summary shown in listings.")),
  subagent_type: Schema.optionalKey(Schema.String.annotate(d("Profile name. Default general-purpose."))),
  harness: Schema.optionalKey(
    Schema.Literals(["pi", "claude"]).annotate(
      d("Child harness: pi or claude. Default: profile, then the parent's harness."),
    ),
  ),
  model: Schema.optionalKey(
    Schema.String.annotate(
      d(
        "Model id in the child harness's own format. Default inherits the parent model when the harness matches, else the child harness default.",
      ),
    ),
  ),
  thinking: Schema.optionalKey(Schema.String.annotate(d("off|minimal|low|medium|high|xhigh|max"))),
  cwd: Schema.optionalKey(
    Schema.String.annotate(
      d(
        "Working directory. Default: the parent cwd; on a machine, the same path relative to the remote home. Must exist on the machine the child runs on.",
      ),
    ),
  ),
  machine: Schema.optionalKey(
    Schema.String.annotate(
      d(
        "Saved herdr machine (id or label from `herdr machine list`) to run the child on. Default: this machine. A machine child cannot spawn children.",
      ),
    ),
  ),
  run_in_background: Schema.optionalKey(
    Schema.Boolean.annotate(
      d(
        "false (default): block until the child's turn ends and return its report. true: return at once, the report arrives later as a message.",
      ),
    ),
  ),
  name: Schema.optionalKey(Schema.String.annotate(d("Short handle used in the agent id."))),
  resume: Schema.optionalKey(
    Schema.String.annotate(
      d(
        "Existing agent id to continue with this prompt: a child, or an idle pi or claude peer from ListAgents. Its report comes back here like a spawn's.",
      ),
    ),
  ),
  timeout_ms: Schema.optionalKey(
    Schema.Int.annotate(d("0 = no timeout. On timeout returns partial output, child keeps running.")),
  ),
});

const ResultParams = Schema.Struct({
  agent_id: Schema.String,
  wait: Schema.optionalKey(Schema.Boolean),
  timeout_ms: Schema.optionalKey(Schema.Int),
});

const SendParams = Schema.Struct({
  to: Schema.optionalKey(Schema.String.annotate(d("Agent id from ListAgents, or a pane id. Default: parent."))),
  message: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["message", "interrupt", "keys"])),
  expect_reply: Schema.optionalKey(
    Schema.Boolean.annotate(d("Mark this agent as waiting for the recipient's reply.")),
  ),
});

const KillParams = Schema.Struct({ agent_id: Schema.String });

const ListParams = Schema.Struct({
  relation: Schema.optionalKey(
    Schema.Literals(["parent", "child", "peer"]).annotate(d("Only agents with this relation to this session.")),
  ),
  status: Schema.optionalKey(
    Schema.String.annotate(
      d(
        "Only agents with this status: queued, starting, running, blocked, idle, closed, killed or unknown. Killed children whose pane is gone are listed only when asked for with status=killed.",
      ),
    ),
  ),
});

/**
 * A tool from its params schema: the JSON Schema the harness shows the model
 * comes from the same schema that decodes the call.
 */
const tool = <S extends Schema.Decoder<any>>(def: {
  name: string;
  description: string;
  params: S;
  run: (params: S["Type"], abort: Effect.Effect<void>) => Effect.Effect<ToolResult>;
}): Tool => ({
  name: def.name,
  description: def.description,
  parameters: Schema.toJsonSchemaDocument(def.params).schema as Record<string, unknown>,
  run: (params, abort = Effect.never) =>
    Schema.decodeUnknownEffect(def.params)(params).pipe(
      Effect.matchEffect({
        onFailure: (e) => Effect.succeed(err(`${def.name}: invalid arguments: ${e.message}`)),
        onSuccess: (p) => def.run(p, abort),
      }),
    ),
});

export interface ToolSet {
  agent: Tool;
  result: Tool;
  send: Tool;
  kill: Tool;
  list: Tool;
  all: Tool[];
  manager: Manager;
}

/** Where this session sits in the agent tree, read once. */
const ToolEnv = Config.all({
  parentPane: Config.String(ENV_PARENT).pipe(Config.withDefault("")),
  depth: Config.Int(ENV_DEPTH).pipe(Config.withDefault(0)),
  myProfile: Config.String(ENV_PROFILE).pipe(Config.withDefault("")),
  myId: Config.String(ENV_ID).pipe(Config.withDefault("")),
  pane: Config.String("HERDR_PANE_ID").pipe(Config.withDefault("")),
});

/** Build the tools for the parent harness. Its cwd is read per call so project config is live. */
export const makeTools: Effect.Effect<
  ToolSet,
  never,
  Herdr | ParentHarness | CurrentSettings | Scope.Scope
> = Effect.gen(function* () {
  const { parentPane, depth, myProfile, myId, pane } = yield* Effect.orDie(ToolEnv);
  const dir = yield* Effect.orDie(agentDir);
  const pHarness = yield* ParentHarness;
  const settings = yield* CurrentSettings;
  // Read once: a harness reads tool descriptions at startup only. Spawn
  // still checks the live list, so a stale entry only costs an error.
  const machines = (yield* (yield* Herdr).machineList().pipe(Effect.orElseSucceed(() => []))).map((m) => m.label);
  const manager = yield* Manager.make;

  const agent = tool({
    name: "Agent",
    description: `Spawn a child coding agent (pi or Claude Code) in its own herdr tab, on this machine or on a saved herdr machine. By default blocks until the child's turn ends and returns its report; run_in_background returns at once and the report arrives later as a message. The child stays alive and idle afterwards: continue it with SendMessage (background) or \`resume\` (same wait semantics as a spawn), close it with KillAgent.${machines.length ? ` Saved machines: ${machines.join(", ")}.` : ""}`,
    params: AgentParams,
    run: (p, abort) =>
      Effect.gen(function* () {
        const cwd = pHarness.cwd();
        const profiles = yield* loadProfiles(cwd, dir);
        const typeName = p.subagent_type ?? "general-purpose";
        const profile = profiles.get(typeName);
        if (!profile)
          return err(`unknown subagent_type ${typeName}. Available: ${[...profiles.keys()].join(", ")}`);
        if (myProfile) {
          const allowed = profiles.get(myProfile)?.allowedSubagents ?? "all";
          if (allowed !== "all" && !allowed.includes(typeName))
            return err(`profile ${myProfile} may only spawn: ${allowed.join(", ") || "nothing"}`);
        }
        const s = yield* settings.get;
        const harness: Harness = p.harness ?? profile.harness ?? pHarness.harness;
        const r = yield* manager.spawn(
          {
            prompt: p.prompt,
            description: p.description,
            profile,
            harness,
            model:
              p.model ??
              profile.model ??
              s.defaultModel ??
              (harness === pHarness.harness ? pHarness.model?.() : undefined),
            thinking: p.thinking ?? profile.thinking ?? pHarness.thinking?.(),
            cwd: p.cwd ?? (p.machine ? machineCwd(cwd) : cwd),
            machine: p.machine,
            background: p.run_in_background ?? false,
            name: p.name,
            resume: p.resume,
            timeoutMs: p.timeout_ms ?? s.defaultTimeoutMs,
            depth: depth + 1,
          },
          abort,
        );
        return ok(r.text, { id: r.id, status: r.status });
      }).pipe(Effect.catch((e) => Effect.succeed(err(`Agent failed: ${e.message}`)))),
  });

  const result = tool({
    name: "GetAgentResult",
    description:
      "Status and output of any agent from ListAgents: the report of its latest turn when idle (pi and claude), else its recent screen. With wait=true blocks until it finishes or blocks on a question.",
    params: ResultParams,
    run: (p, abort) =>
      settings.get.pipe(
        Effect.flatMap((s) => manager.result(p.agent_id, p.wait ?? false, p.timeout_ms ?? s.defaultTimeoutMs, abort)),
        Effect.map((text) => ok(text)),
        Effect.catch((e) => Effect.succeed(err(e.message))),
      ),
  });

  const send = tool({
    name: "SendMessage",
    description:
      "Send text to any agent from ListAgents, child or peer. The recipient sees `[from <your id>]` and replies with its own SendMessage. To an idle child this starts a new turn and its report arrives later as a message; a peer's report does not come back (use Agent resume for that). Omit `to` to reach the parent (child agents only). kind=message queues a prompt (steers if the target is busy), kind=interrupt presses esc first, kind=keys sends raw keys like `enter` or `ctrl+c`. Set expect_reply=true when you need an answer before continuing: end your turn after calling it, the reply arrives as your next message.",
    params: SendParams,
    run: (p) =>
      Effect.gen(function* () {
        const to = p.to ?? parentPane;
        if (!to) return err("no `to` given and this agent has no parent");
        const kind = p.kind ?? "message";
        const me = myId || pane;
        const prefix = kind !== "keys" && me ? `[from ${me}] ` : "";
        const sent = yield* manager.send(to, prefix + p.message, kind).pipe(
          Effect.as(undefined),
          Effect.catch((e) => Effect.succeed(err(`SendMessage failed: ${e.message}`))),
        );
        if (sent) return sent;
        if (p.expect_reply) {
          const who = p.to ?? "parent";
          yield* pHarness.setBlocked(true, `awaiting ${who}`);
          return ok(`Sent to ${who}. End your turn now and wait for the reply.`);
        }
        return ok(`Sent to ${to}.`);
      }),
  });

  const kill = tool({
    name: "KillAgent",
    description: "Close a child agent's pane. Irreversible. Only this session's children, never a peer.",
    params: KillParams,
    run: (p) =>
      manager.kill(p.agent_id).pipe(
        Effect.as(ok(`${p.agent_id} killed`)),
        Effect.catch((e) => Effect.succeed(err(e.message))),
      ),
  });

  const list = tool({
    name: "ListAgents",
    description:
      "Every agent herdr sees, on this machine and on enabled saved machines, one per line: id, relation to this session (parent, child, peer), harness, status, machine, cwd. Children add profile, model and description. A child's model is the resolved one once it has answered. A queued child shows its place in the queue. Killed children whose pane is gone are hidden unless status=killed. Ids off this machine are `<machine>/<id>`. Use the ids as SendMessage `to`, Agent `resume` and GetAgentResult `agent_id`.",
    params: ListParams,
    run: (p) =>
      Effect.gen(function* () {
        const every = yield* manager.agents();
        // Queue order is spawn order, which is the order `agents()` lists queued children in.
        const queued = every.filter((a) => a.status === "queued");
        const all = every.filter(
          (a) =>
            (!p.relation || a.relation === p.relation) &&
            (p.status ? a.status === p.status : a.live || a.status !== "killed"),
        );
        if (!all.length) return ok("no other agents");
        return ok(
          all
            .map((a) =>
              [
                a.id,
                a.relation,
                a.harness ?? "-",
                a.status === "queued" ? `queued #${queued.indexOf(a) + 1}/${queued.length}` : a.status,
                a.machine?.label ?? "local",
                a.cwd ?? "-",
                ...(a.child ? [a.child.profile, a.child.model ?? "default model", a.child.description] : []),
              ].join("  "),
            )
            .join("\n"),
        );
      }),
  });

  yield* log("tools_created", { harness: pHarness.harness, depth, profile: myProfile || undefined });
  return {
    agent,
    result,
    send,
    kill,
    list,
    all: [agent, result, send, kill, list],
    manager,
  };
});

/** A tool as a parent harness calls it: aborting the signal detaches, it never rejects. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export interface Tools {
  agent: ToolDef;
  result: ToolDef;
  send: ToolDef;
  kill: ToolDef;
  list: ToolDef;
  all: ToolDef[];
  manager: Manager;
  /** Run a Manager effect on this runtime. */
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  /** Send held Deliveries. Synchronous for a parent whose `deliver` is. */
  flush(): void;
  /** Interrupt every background wait. */
  dispose(): Promise<void>;
}

class ToolsService extends Context.Service<ToolsService, ToolSet>()("herdr-agents/Tools") {}

/** Completes when the signal aborts, never without one. */
const aborted = (signal?: AbortSignal): Effect.Effect<void> =>
  signal
    ? Effect.callback<void>((resume) => {
        if (signal.aborted) return resume(Effect.void);
        const on = () => resume(Effect.void);
        signal.addEventListener("abort", on, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", on));
      })
    : Effect.never;

/**
 * The tools on one runtime for the parent harness's process. Background
 * waits live until `dispose`.
 */
export async function createTools(
  parent: Layer.Layer<ParentHarness, never, Herdr>,
  herdr: Layer.Layer<Herdr> = Herdr.layer,
): Promise<Tools> {
  // The file logger also covers building the layers: the default logger
  // writes to stdout, which is the MCP channel.
  const runtime = ManagedRuntime.make(
    Layer.effect(ToolsService, makeTools).pipe(
      Layer.provideMerge(CurrentSettings.layer),
      Layer.provideMerge(parent),
      Layer.provideMerge(herdr),
      Layer.provideMerge(FileLogger),
    ),
  );
  const set = await runtime.runPromise(ToolsService.use(Effect.succeed));
  const bridge = (t: Tool): ToolDef => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    execute: (params, signal) => runtime.runPromise(t.run(params, aborted(signal))),
  });
  const agent = bridge(set.agent);
  const result = bridge(set.result);
  const send = bridge(set.send);
  const kill = bridge(set.kill);
  const list = bridge(set.list);
  return {
    agent,
    result,
    send,
    kill,
    list,
    all: [agent, result, send, kill, list],
    manager: set.manager,
    run: (effect) => runtime.runPromise(effect),
    flush: () => runtime.runSync(set.manager.flush()),
    dispose: () => runtime.dispose(),
  };
}
