/**
 * tools.ts: the five tools, harness-neutral. Each parent harness wraps them in its own
 * registration API (pi registerTool, MCP tools/list + tools/call).
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { h as defaultHerdr, type Herdr, log } from "./herdr.ts";
import {
  ENV_DEPTH,
  ENV_ID,
  ENV_PARENT,
  ENV_PROFILE,
  Manager,
} from "./manager.ts";
import type { Harness, ParentHarness } from "./parent-harness.ts";
import { loadProfiles } from "./profiles.ts";
import { loadSettings } from "./settings.ts";

export interface ToolResult {
  text: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface ToolDef<S extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: S;
  execute(params: Static<S>, signal?: AbortSignal): Promise<ToolResult>;
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

const AgentParams = Type.Object({
  prompt: Type.String({
    description:
      "Task for the child. Self-contained, the child has no conversation context.",
  }),
  description: Type.String({ description: "3-5 word summary shown in listings." }),
  subagent_type: Type.Optional(
    Type.String({ description: "Profile name. Default general-purpose." }),
  ),
  harness: Type.Optional(
    Type.Union([Type.Literal("pi"), Type.Literal("claude")], {
      description:
        "Child harness: pi or claude. Default: profile, then the parent's harness.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model id in the child harness's own format. Default inherits the parent model when the harness matches, else the child harness default.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory. Default: the parent cwd; on a machine, the same path relative to the remote home. Must exist on the machine the child runs on.",
    }),
  ),
  machine: Type.Optional(
    Type.String({
      description:
        "Saved herdr machine (id or label from `herdr machine list`) to run the child on. Default: this machine. A machine child cannot spawn children.",
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "false (default): block until the child's turn ends and return its report. true: return at once, the report arrives later as a message.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Short handle used in the agent id." }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Existing agent id to continue with this prompt: a child, or an idle pi or claude peer from ListAgents. Its report comes back here like a spawn's.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "0 = no timeout. On timeout returns partial output, child keeps running.",
    }),
  ),
});

const ResultParams = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean()),
  timeout_ms: Type.Optional(Type.Number()),
});

const SendParams = Type.Object({
  to: Type.Optional(
    Type.String({ description: "Agent id from ListAgents, or a pane id. Default: parent." }),
  ),
  message: Type.String(),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("message"),
      Type.Literal("interrupt"),
      Type.Literal("keys"),
    ]),
  ),
  expect_reply: Type.Optional(
    Type.Boolean({ description: "Mark this agent as waiting for the recipient's reply." }),
  ),
});

const KillParams = Type.Object({ agent_id: Type.String() });

const ListParams = Type.Object({
  relation: Type.Optional(
    Type.Union([Type.Literal("parent"), Type.Literal("child"), Type.Literal("peer")], {
      description: "Only agents with this relation to this session.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Only agents with this status, e.g. running, queued, idle, blocked, killed. Killed children whose pane is gone are listed only when asked for with status=killed.",
    }),
  ),
});

export interface ToolSet {
  agent: ToolDef<typeof AgentParams>;
  result: ToolDef<typeof ResultParams>;
  send: ToolDef<typeof SendParams>;
  kill: ToolDef<typeof KillParams>;
  list: ToolDef<typeof ListParams>;
  all: ToolDef[];
  manager(): Manager;
}

/** Build the tools for a parent harness. `cwd` is resolved per call so project config is live. */
export function createTools(
  pHarness: ParentHarness,
  cwd: () => string,
  herdr?: Herdr,
): ToolSet {
  const parentPane = process.env[ENV_PARENT];
  const depth = Number(process.env[ENV_DEPTH] ?? 0);
  const myProfile = process.env[ENV_PROFILE];
  const myId = process.env[ENV_ID];
  // Read once: a harness reads tool descriptions at startup only. Spawn
  // still checks the live list, so a stale entry only costs an error.
  const machines = (herdr ?? defaultHerdr).machineLabels();
  let manager: Manager | undefined;
  const getManager = () => {
    manager ??= new Manager(pHarness, loadSettings(cwd()), herdr);
    return manager;
  };

  const agent: ToolDef<typeof AgentParams> = {
    name: "Agent",
    description: `Spawn a child coding agent (pi or Claude Code) in its own herdr tab, on this machine or on a saved herdr machine. By default blocks until the child's turn ends and returns its report; run_in_background returns at once and the report arrives later as a message. The child stays alive and idle afterwards: continue it with SendMessage (background) or \`resume\` (same wait semantics as a spawn), close it with KillAgent.${machines.length ? ` Saved machines: ${machines.join(", ")}.` : ""}`,
    parameters: AgentParams,
    async execute(p, signal) {
      const dir = cwd();
      const m = getManager();
      const profiles = loadProfiles(dir);
      const typeName = p.subagent_type ?? "general-purpose";
      const profile = profiles.get(typeName);
      if (!profile)
        return err(
          `unknown subagent_type ${typeName}. Available: ${[...profiles.keys()].join(", ")}`,
        );
      if (myProfile) {
        const allowed = profiles.get(myProfile)?.allowedSubagents ?? "all";
        if (allowed !== "all" && !allowed.includes(typeName)) {
          return err(
            `profile ${myProfile} may only spawn: ${allowed.join(", ") || "nothing"}`,
          );
        }
      }
      const settings = loadSettings(dir);
      const harness: Harness = p.harness ?? profile.harness ?? pHarness.harness;
      try {
        const r = await m.spawn(
          {
            prompt: p.prompt,
            description: p.description,
            profile,
            harness,
            model:
              p.model ??
              profile.model ??
              settings.defaultModel ??
              (harness === pHarness.harness ? pHarness.model?.() : undefined),
            thinking: p.thinking ?? profile.thinking ?? pHarness.thinking?.(),
            cwd: p.cwd ?? (p.machine ? machineCwd(dir) : dir),
            machine: p.machine,
            background: p.run_in_background ?? false,
            name: p.name,
            resume: p.resume,
            timeoutMs: p.timeout_ms ?? settings.defaultTimeoutMs,
            depth: depth + 1,
          },
          signal,
        );
        return ok(r.text, { id: r.id, status: r.status });
      } catch (e) {
        return err(`Agent failed: ${String(e)}`);
      }
    },
  };

  const result: ToolDef<typeof ResultParams> = {
    name: "GetAgentResult",
    description:
      "Status and output of any agent from ListAgents: the report of its latest turn when idle (pi and claude), else its recent screen. With wait=true blocks until it finishes or blocks on a question.",
    parameters: ResultParams,
    async execute(p, signal) {
      try {
        const settings = loadSettings(cwd());
        return ok(
          await getManager().result(
            p.agent_id,
            p.wait ?? false,
            p.timeout_ms ?? settings.defaultTimeoutMs,
            signal,
          ),
        );
      } catch (e) {
        return err(String(e));
      }
    },
  };

  const send: ToolDef<typeof SendParams> = {
    name: "SendMessage",
    description:
      "Send text to any agent from ListAgents, child or peer. The recipient sees `[from <your id>]` and replies with its own SendMessage. To an idle child this starts a new turn and its report arrives later as a message; a peer's report does not come back (use Agent resume for that). Omit `to` to reach the parent (child agents only). kind=message queues a prompt (steers if the target is busy), kind=interrupt presses esc first, kind=keys sends raw keys like `enter` or `ctrl+c`. Set expect_reply=true when you need an answer before continuing: end your turn after calling it, the reply arrives as your next message.",
    parameters: SendParams,
    async execute(p) {
      const to = p.to ?? parentPane;
      if (!to) return err("no `to` given and this agent has no parent");
      const kind = p.kind ?? "message";
      const me = myId ?? process.env.HERDR_PANE_ID;
      const prefix = kind !== "keys" && me ? `[from ${me}] ` : "";
      try {
        await getManager().send(to, prefix + p.message, kind);
      } catch (e) {
        return err(`SendMessage failed: ${String(e)}`);
      }
      if (p.expect_reply) {
        const who = p.to ?? "parent";
        pHarness.setBlocked(true, `awaiting ${who}`);
        return ok(`Sent to ${who}. End your turn now and wait for the reply.`);
      }
      return ok(`Sent to ${to}.`);
    },
  };

  const kill: ToolDef<typeof KillParams> = {
    name: "KillAgent",
    description: "Close a child agent's pane. Irreversible. Only this session's children, never a peer.",
    parameters: KillParams,
    async execute(p) {
      try {
        await getManager().kill(p.agent_id);
        return ok(`${p.agent_id} killed`);
      } catch (e) {
        return err(String(e));
      }
    },
  };

  const list: ToolDef<typeof ListParams> = {
    name: "ListAgents",
    description:
      "Every agent herdr sees, on this machine and on enabled saved machines, one per line: id, relation to this session (parent, child, peer), harness, status, machine, cwd. Children add profile, model and description. A child's model is the resolved one once it has answered. A queued child shows its place in the queue. Killed children whose pane is gone are hidden unless status=killed. Ids off this machine are `<machine>/<id>`. Use the ids as SendMessage `to`, Agent `resume` and GetAgentResult `agent_id`.",
    parameters: ListParams,
    async execute(p) {
      const every = await getManager().agents();
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
    },
  };

  log("tools_created", { harness: pHarness.harness, depth, profile: myProfile });
  return {
    agent,
    result,
    send,
    kill,
    list,
    all: [agent, result, send, kill, list],
    manager: getManager,
  };
}
