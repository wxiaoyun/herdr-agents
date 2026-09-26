/**
 * manager.ts: child registry, concurrency slots, spawn / wait / report / kill.
 * All herdr access goes through the Herdr service. A Machine child gets the
 * same client bound to its machine. Every background wait runs as one fiber
 * per child, so a new wait or a kill interrupts the old one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Clock, Config, Data, Effect, FiberMap, Option, Result, type Scope, Semaphore } from "effect";
import { childArgs } from "./args.ts";
import { type AgentInfo, Herdr, type HerdrClient, HerdrError, isHerdrCode, type Machine } from "./herdr.ts";
import { log } from "./log.ts";
import { type Harness, ParentHarness, type ParentHarnessShape } from "./parent-harness.ts";
import { claudeDir } from "./paths.ts";
import type { Profile } from "./profiles.ts";
import {
  abnormalStop,
  formatStats,
  formatUsage,
  parseLastSpeaker,
  parseReport,
  type Report,
  sessionPathFor,
} from "./session.ts";
import { CurrentSettings, type Settings } from "./settings.ts";

/** A failure the agent should read: unknown ids, refused operations, a child that died. */
export class AgentError extends Data.TaggedError("AgentError")<{ readonly message: string }> {}

/** The text of any failure, for a tool result. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type ChildStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "idle"
  | "done"
  | "timeout"
  | "killed"
  | "unknown";

export interface Child {
  id: string;
  profile: string;
  harness: Harness;
  /** Absent: the parent's own machine. */
  machine?: Machine;
  /** Absolute cwd as herdr reported it for the child's tab. */
  cwd?: string;
  model?: string;
  description: string;
  pane?: string;
  background: boolean;
  status: ChildStatus;
  sessionPath?: string;
  sessionId?: string;
  report?: Report;
  startedAt: number;
  /** Holds a concurrency slot. */
  slot: boolean;
  /** herdr name or pane id on its own server, when it differs from `id`. */
  ref?: string;
  /** A Peer this session Resumed: gets Delivery, is never killed or relaunched. */
  peer?: boolean;
}

export interface AgentEntry {
  /** herdr label, else pane id, prefixed `<machine label>/` off the local machine. */
  id: string;
  relation: "parent" | "child" | "peer";
  /** Harness herdr detected, e.g. pi, claude, codex. */
  harness?: string;
  status: string;
  cwd?: string;
  machine?: Machine;
  child?: Child;
  /** herdr still lists it. False for a queued, killed or unreachable child. */
  live: boolean;
}

export interface SpawnOpts {
  prompt: string;
  description: string;
  profile: Profile;
  harness: Harness;
  model?: string;
  thinking?: string;
  cwd: string;
  /** Saved herdr machine id or label. */
  machine?: string;
  background: boolean;
  name?: string;
  timeoutMs: number;
  depth: number;
  /** Existing child id to continue instead of starting fresh. */
  resume?: string;
}

export interface SpawnResult {
  id: string;
  status: ChildStatus | "detached";
  text: string;
}

export const ENV_PARENT = "HERDR_AGENTS_PARENT";
export const ENV_DEPTH = "HERDR_AGENTS_DEPTH";
export const ENV_ID = "HERDR_AGENTS_ID";
export const ENV_PROFILE = "HERDR_AGENTS_PROFILE";
export const ENV_HARNESS = "HERDR_AGENTS_HARNESS";

/** This session's place in herdr, read once. Empty when unset. */
const SessionEnv = Config.all({
  pane: Config.String("HERDR_PANE_ID").pipe(Config.withDefault("")),
  workspace: Config.String("HERDR_WORKSPACE_ID").pipe(Config.withDefault("")),
  parent: Config.String(ENV_PARENT).pipe(Config.withDefault("")),
  claudeDir,
});
type SessionEnv = Config.Success<typeof SessionEnv>;

/** Workspace label for children of `label`. Idempotent. */
export const CHILD_WS_SUFFIX = "-agents";
export const childWorkspaceLabel = (label: string): string =>
  label.endsWith(CHILD_WS_SUFFIX) ? label : `${label}${CHILD_WS_SUFFIX}`;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";

const stripSlash = (p: string): string => p.replace(/\/+$/, "") || "/";

/**
 * Did herdr honour the requested cwd? `~` is the home herdr falls back to
 * anyway. A relative cwd resolves against the home of the child's machine.
 */
// ponytail: a relative cwd equal to the home's own basename would pass when
// missing; resolve the remote home first if that ever matters.
export const sameDir = (got: string, asked: string): boolean => {
  const a = stripSlash(asked);
  if (a === "~") return true;
  const g = stripSlash(got);
  return a.startsWith("/") ? g === a : g.endsWith(`/${a}`);
};

/**
 * herdr `agent prompt --wait` errors with `agent_prompt_stalled` when the
 * whole turn completes before it observes a working/blocked state. The
 * session file decides within this grace period.
 */
const STALL_GRACE_MS = 30_000;
/** Pause before looking again at a turn herdr called over mid tool call. */
const SETTLE = "2 seconds";

const orUndefined = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A | undefined> =>
  eff.pipe(Effect.option, Effect.map(Option.getOrUndefined));

/** `eff`'s outcome, or None when `abort` completes first (then `eff` is interrupted). */
const unlessAborted = <A, E>(
  eff: Effect.Effect<A, E>,
  abort: Effect.Effect<void>,
): Effect.Effect<Option.Option<Result.Result<A, E>>> =>
  Effect.raceFirst(Effect.result(eff).pipe(Effect.map(Option.some)), abort.pipe(Effect.as(Option.none())));

/** A wait bounded by `ms`, 0 meaning none. Runs out as a HerdrError with code `timeout`. */
const withTimeout = <A, E>(eff: Effect.Effect<A, E>, ms: number): Effect.Effect<A, E | HerdrError> =>
  ms > 0
    ? eff.pipe(
        Effect.timeoutOrElse({
          duration: ms,
          orElse: () => Effect.fail(new HerdrError({ message: `timed out after ${ms} ms`, code: "timeout" })),
        }),
      )
    : eff;

export class Manager {
  readonly children = new Map<string, Child>();
  /** One background fiber per child: its queued launch or its wait. */
  readonly watchers: FiberMap.FiberMap<string>;
  private counter = 0;
  private readonly childWs = new Map<string, string>();
  /** Children whose Delivery waits for the parent's turn to end. */
  private readonly held = new Set<Child>();
  private readonly h: HerdrClient;
  private readonly parent: ParentHarnessShape;
  private readonly settings: Settings;
  private readonly env: SessionEnv;
  private readonly slots: Semaphore.Semaphore;

  constructor(deps: {
    h: HerdrClient;
    parent: ParentHarnessShape;
    settings: Settings;
    env: SessionEnv;
    slots: Semaphore.Semaphore;
    watchers: FiberMap.FiberMap<string>;
  }) {
    this.h = deps.h;
    this.parent = deps.parent;
    this.settings = deps.settings;
    this.env = deps.env;
    this.slots = deps.slots;
    this.watchers = deps.watchers;
  }

  /** Watchers live as long as the scope. */
  static readonly make: Effect.Effect<Manager, never, Herdr | ParentHarness | CurrentSettings | Scope.Scope> =
    Effect.gen(function* () {
      const settings = yield* (yield* CurrentSettings).get;
      return new Manager({
        h: yield* Herdr,
        parent: yield* ParentHarness,
        settings,
        env: yield* Effect.orDie(SessionEnv),
        slots: yield* Semaphore.make(settings.maxConcurrent),
        watchers: yield* FiberMap.make<string>(),
      });
    });

  list(): Child[] {
    return [...this.children.values()];
  }

  private ref(child: Child): string {
    return child.ref ?? child.id;
  }

  private idOf(child: Child): string {
    return child.machine && !child.peer ? `${child.machine.label}/${child.id}` : child.id;
  }

  /** A child or Resumed Peer by the id `agents()` shows. */
  private lookup(id: string): Child | undefined {
    return this.children.get(id) ?? this.list().find((c) => this.idOf(c) === id);
  }

  /** Where an id lives: a known child, else `<machine label>/<ref>` or a local ref. */
  private target(
    id: string,
  ): Effect.Effect<{ child?: Child; machine?: Machine; ref: string }, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const child = this.lookup(id);
      if (child) return { child, machine: child.machine, ref: this.ref(child) };
      const slash = id.indexOf("/");
      if (slash < 0) return { ref: id };
      return { machine: yield* this.machineFor(id.slice(0, slash)), ref: id.slice(slash + 1) };
    });
  }

  /** Every agent herdr sees, locally and on enabled saved machines, except this session. */
  agents(): Effect.Effect<AgentEntry[]> {
    return Effect.gen({ self: this }, function* () {
      const machines = (yield* this.h.machineList().pipe(Effect.orElseSucceed((): Machine[] => []))).filter(
        (m) => m.enabled !== false,
      );
      const where: Array<Machine | undefined> = [undefined, ...machines];
      const lists = yield* Effect.forEach(
        where,
        (machine) =>
          this.hFor({ machine })
            .agentList()
            .pipe(
              Effect.catch((e) =>
                log("agent_list", { machine: machine?.label, error: e.message }).pipe(Effect.as([] as AgentInfo[])),
              ),
            ),
        { concurrency: "unbounded" },
      );
      const out: AgentEntry[] = [];
      const seen = new Set<Child>();
      lists.forEach((infos, i) => {
        const machine = where[i];
        for (const a of infos) {
          if (!machine && a.pane === this.env.pane) continue;
          const ref = a.name ?? a.pane;
          const id = machine ? `${machine.label}/${ref}` : ref;
          const found = this.lookup(id);
          if (found) seen.add(found);
          const child = found && !found.peer ? found : undefined;
          out.push({
            id,
            relation: child ? "child" : !machine && a.pane === this.env.parent ? "parent" : "peer",
            harness: a.harness,
            status: child?.status ?? a.status,
            cwd: a.cwd,
            machine,
            child,
            live: true,
          });
        }
      });
      // Children herdr no longer lists (queued, killed, or on an unreachable machine).
      for (const c of this.children.values())
        if (!c.peer && !seen.has(c))
          out.push({
            id: this.idOf(c),
            relation: "child",
            harness: c.harness,
            status: c.status,
            cwd: c.cwd,
            machine: c.machine,
            child: c,
            live: false,
          });
      return out;
    });
  }

  /** A Child-shaped record for a Peer, so Resume and reports reuse the child paths. */
  private peer(id: string, background = true): Effect.Effect<Child, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const { machine, ref } = yield* this.target(id);
      const info = yield* this.hFor({ machine })
        .agentGet(ref)
        .pipe(Effect.mapError((e) => new AgentError({ message: `unknown agent ${id}: ${e.message}` })));
      const harness = info.harness === "pi" || info.harness === "claude" ? info.harness : undefined;
      return {
        id,
        ref,
        machine,
        peer: true,
        harness: (harness ?? info.harness ?? "unknown") as Harness,
        profile: "peer",
        description: "",
        cwd: info.cwd,
        pane: info.pane,
        background,
        status: info.status === "working" ? "running" : info.status,
        sessionId: info.sessionId,
        sessionPath: harness
          ? (info.sessionPath ??
            sessionPathFor(harness, info.cwd ?? "~", info.sessionId, machine ? "~/.claude" : this.env.claudeDir))
          : undefined,
        startedAt: Date.now(),
        slot: false,
      };
    });
  }

  /** herdr client for where this child lives. */
  private hFor(child: { machine?: Machine } | undefined): HerdrClient {
    return child?.machine ? this.h.machine(child.machine) : this.h;
  }

  // ---- concurrency slots ----------------------------------------------------

  private free(): Effect.Effect<number> {
    return this.slots.release(0);
  }

  /** Take a slot for `child`, waiting in line. Fails when `abort` completes first. */
  private acquire(child: Child, abort: Effect.Effect<void> = Effect.never): Effect.Effect<void, AgentError> {
    return Effect.gen({ self: this }, function* () {
      if ((yield* this.free()) === 0) yield* log("queue_wait", { id: child.id });
      const take = Effect.uninterruptibleMask((restore) =>
        restore(this.slots.take(1)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              child.slot = true;
            }),
          ),
        ),
      );
      const got = yield* Effect.raceFirst(take.pipe(Effect.as(true)), abort.pipe(Effect.as(false)));
      if (got) return;
      yield* this.release(child);
      return yield* new AgentError({ message: "aborted while queued" });
    });
  }

  private release(child: Child): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!child.slot) return Effect.void;
      child.slot = false;
      return Effect.asVoid(this.slots.release(1));
    });
  }

  // ---- spawn ----------------------------------------------------------------

  private machineFor(name: string | undefined): Effect.Effect<Machine | undefined, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      if (!name) return undefined;
      const all = yield* this.h.machineList();
      const found = all.find((m) => m.id === name || m.label === name);
      if (!found)
        return yield* new AgentError({
          message: `unknown machine ${name}. Saved machines: ${all.map((m) => m.label).join(", ") || "none"}`,
        });
      return found;
    });
  }

  /** `<child harness>-<name>-<n>`, unique among the live agents on the child's machine. */
  private newId(base: string, harness: Harness, h: HerdrClient): Effect.Effect<string> {
    return Effect.gen({ self: this }, function* () {
      const live = new Set((yield* h.agentList().pipe(Effect.orElseSucceed((): AgentInfo[] => []))).map((a) => a.name));
      let id: string;
      do {
        this.counter++;
        id = `${harness}-${slug(base)}-${this.counter}`.slice(0, 32);
      } while (this.children.has(id) || live.has(id));
      return id;
    });
  }

  private model(o: SpawnOpts): string | undefined {
    return o.model ?? o.profile.model ?? this.settings.defaultModel ?? undefined;
  }

  private launch(child: Child, o: SpawnOpts, session?: string): Effect.Effect<void, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const h = this.hFor(child);
      child.status = "starting";
      child.model = this.model(o);
      const env = {
        // A Machine child cannot reach the parent's pane, so it gets no parent.
        [ENV_PARENT]: child.machine ? "" : this.env.pane,
        [ENV_DEPTH]: String(o.depth),
        [ENV_ID]: child.id,
        [ENV_PROFILE]: o.profile.name,
        [ENV_HARNESS]: o.harness,
      };
      const [pane, cwd] = yield* this.place(child, o.cwd, env);
      child.pane = pane;
      child.cwd = cwd;
      // herdr cannot pass args containing newlines; stage multi-line profile
      // prompts in a temp file (pi reads the path at startup) and clean up after
      // the child is interactive. A Machine child reads a copy under /tmp over there.
      const started = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const staged = mkdtempSync(join(tmpdir(), "herdr-agents-"));
          return { staged, stagedAs: child.machine ? `/tmp/${basename(staged)}` : staged };
        }),
        ({ staged, stagedAs }) =>
          Effect.gen({ self: this }, function* () {
            const args = yield* Effect.try({
              try: () =>
                childArgs(
                  o.harness,
                  {
                    id: child.id,
                    profile: o.profile,
                    model: this.model(o),
                    thinking: o.thinking ?? o.profile.thinking,
                    session,
                    stagedDir: staged,
                    stagedAs,
                    remote: !!child.machine,
                  },
                  this.settings,
                ),
              catch: (e) => new AgentError({ message: messageOf(e) }),
            });
            yield* h.stage(staged, stagedAs);
            yield* h.agentStart(child.id, pane, o.harness, args);
          }),
        ({ staged, stagedAs }) =>
          Effect.sync(() => rmSync(staged, { recursive: true, force: true })).pipe(Effect.andThen(h.unstage(stagedAs))),
      ).pipe(
        Effect.as(true),
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            if (isHerdrCode(e, "agent_not_ready")) {
              // A startup dialog (folder trust, login). herdr keeps the pane and
              // the name; the prompt goes in once someone answers it.
              yield* log("agent_start_blocked", { id: child.id, pane });
              child.status = "blocked";
              return false;
            }
            yield* log("agent_start_failed", { id: child.id, error: e.message });
            // The harness usually says why on its way out (unknown model, tool
            // name conflict), and the pane is about to close.
            const screen = yield* h.paneRead(pane, 30).pipe(Effect.orElseSucceed(() => ""));
            yield* this.closePane(child);
            if (!screen.trim()) return yield* e;
            return yield* new AgentError({ message: `${e.message}\nlast screen of ${child.id}:\n${screen.trim()}` });
          }),
        ),
      );
      if (started) yield* this.learnSession(child, o);
    });
  }

  private learnSession(child: Child, o: SpawnOpts): Effect.Effect<AgentInfo | undefined> {
    return Effect.gen({ self: this }, function* () {
      const info = yield* orUndefined(this.hFor(child).agentGet(child.id));
      child.sessionId = info?.sessionId;
      child.sessionPath =
        info?.sessionPath ??
        sessionPathFor(
          o.harness,
          child.cwd ?? o.cwd,
          info?.sessionId,
          child.machine ? "~/.claude" : this.env.claudeDir,
        );
      child.status = "running";
      yield* log("launched", {
        id: child.id,
        pane: child.pane,
        machine: child.machine?.label,
        session: child.sessionPath,
      });
      return info;
    });
  }

  /** Wait out a startup dialog, then send the task prompt. */
  private startupWatch(child: Child, o: SpawnOpts): Effect.Effect<void> {
    return this.watcher(
      child,
      this.settle(child, o).pipe(Effect.andThen(this.hFor(child).agentPromptWait(child.id, o.prompt))),
      o.timeoutMs,
    );
  }

  private settle(child: Child, o: SpawnOpts): Effect.Effect<void, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      yield* withTimeout(this.hFor(child).agentWaitUntil(child.id, ["idle"]), o.timeoutMs);
      if (!(yield* this.learnSession(child, o)))
        return yield* new AgentError({
          message: `${child.id} exited during startup (the dialog was probably declined)`,
        });
    });
  }

  /**
   * The child sits on a startup dialog (folder trust, login). Only a person
   * answers it, never the parent: the child pauses until it is idle, then the
   * task prompt goes in. Foreground keeps waiting, background returns
   * `blocked` and delivers the report later.
   */
  private awaitStartup(
    child: Child,
    o: SpawnOpts,
    abort: Effect.Effect<void> = Effect.never,
  ): Effect.Effect<SpawnResult, AgentError> {
    return Effect.gen({ self: this }, function* () {
      if (!o.background) {
        const settled = yield* unlessAborted(this.settle(child, o), abort);
        if (Option.isNone(settled)) {
          yield* log("startup_detach", { id: child.id });
          child.background = true;
          return yield* this.awaitStartup(child, { ...o, background: true });
        }
        if (Result.isFailure(settled.value)) return yield* yield* this.lost(child, settled.value.failure);
        return yield* this.foreground(child, o.prompt, o.timeoutMs, abort);
      }
      yield* this.fork(child, this.startupWatch(child, o));
      return {
        id: child.id,
        status: "blocked",
        text: `${child.id} is waiting on a startup prompt in pane ${child.pane}${this.where(child)} (folder trust, login, or similar). A person has to answer it in the pane. The task prompt is sent once the child is idle and its report arrives as a message.`,
      };
    });
  }

  // ---- placement ------------------------------------------------------------

  /**
   * A tab in the child workspace. herdr silently falls back to $HOME when the
   * cwd is missing (the usual case on a Machine), so the returned cwd is checked.
   */
  private place(
    child: Child,
    cwd: string,
    env: Record<string, string>,
  ): Effect.Effect<[string, string], AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const h = this.hFor(child);
      const ws = yield* this.childWorkspace(child, cwd);
      const made = yield* h.tabCreate(child.id, cwd, env, ws).pipe(
        Effect.catch((e) =>
          Effect.gen({ self: this }, function* () {
            // Someone closed the cached child workspace: resolve it again, once.
            if (!isHerdrCode(e, "workspace_not_found")) return yield* e;
            yield* log("child_workspace_stale", { id: ws, machine: child.machine?.label });
            this.childWs.delete(child.machine?.id ?? "");
            return yield* h.tabCreate(child.id, cwd, env, yield* this.childWorkspace(child, cwd));
          }),
        ),
      );
      // ponytail: exact string compare; a symlinked cwd (macOS /tmp) would trip
      // it, resolve both sides if that bites.
      if (!sameDir(made.cwd, cwd)) {
        child.pane = made.pane;
        yield* this.closePane(child);
        child.pane = undefined;
        return yield* new AgentError({
          message: `cwd ${cwd} does not exist on ${child.machine?.label ?? "this machine"} (herdr fell back to ${made.cwd})`,
        });
      }
      return [made.pane, made.cwd] as [string, string];
    });
  }

  /**
   * herdr relabels an unlabelled workspace after the focused pane's cwd, so
   * the derived label can drift mid-session. Resolve once per parent process
   * and per machine. The label comes from the parent's own workspace.
   */
  private childWorkspace(child: Child, cwd: string): Effect.Effect<string | undefined, HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const mine = this.env.workspace;
      if (!mine) return undefined;
      const key = child.machine?.id ?? "";
      let ws = this.childWs.get(key);
      if (!ws) {
        const label = childWorkspaceLabel(yield* this.h.workspaceLabel(mine));
        ws = yield* this.hFor(child).workspaceByLabel(label, cwd);
        this.childWs.set(key, ws);
        yield* log("child_workspace", { label, id: ws, machine: child.machine?.label });
      }
      return ws;
    });
  }

  private closePane(child: Child): Effect.Effect<void> {
    if (!child.pane) return Effect.void;
    return this.hFor(child)
      .paneClose(child.pane)
      .pipe(Effect.catch((e) => log("pane_close", { id: child.id, error: e.message })));
  }

  spawn(o: SpawnOpts, abort: Effect.Effect<void> = Effect.never): Effect.Effect<SpawnResult, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      if (o.depth > this.settings.maxDepth)
        return yield* new AgentError({ message: `max nesting depth ${this.settings.maxDepth} reached` });
      if (o.resume) return yield* this.resume(o, abort);

      const machine = yield* this.machineFor(o.machine);
      const child: Child = {
        id: yield* this.newId(o.name ?? o.profile.name, o.harness, this.hFor({ machine })),
        profile: o.profile.name,
        harness: o.harness,
        machine,
        model: this.model(o),
        description: o.description,
        background: o.background,
        status: "queued",
        startedAt: Date.now(),
        slot: false,
      };
      this.children.set(child.id, child);
      const failed = (e: AgentError | HerdrError) => this.fail(child, e);

      if (o.background) {
        const free = yield* this.free();
        if (free === 0) {
          // Waits in line in its own fiber. A kill interrupts it before it launches.
          yield* this.fork(
            child,
            this.acquire(child).pipe(
              Effect.andThen(this.launch(child, o)),
              Effect.andThen(
                Effect.suspend(() =>
                  child.status === "blocked"
                    ? this.startupWatch(child, o)
                    : this.promptWatch(child, o.prompt, o.timeoutMs),
                ),
              ),
              Effect.catch(failed),
            ),
          );
          return {
            id: child.id,
            status: "queued",
            text: `${child.id} queued with model ${child.model ?? "default"} (${this.settings.maxConcurrent}/${this.settings.maxConcurrent} slots busy)`,
          };
        }
        yield* this.acquire(child);
        yield* this.launch(child, o).pipe(Effect.tapError(failed));
        if (child.status === "blocked") return yield* this.awaitStartup(child, o);
        yield* this.fork(child, this.promptWatch(child, o.prompt, o.timeoutMs));
        return {
          id: child.id,
          status: "running",
          text: `${child.id} started with model ${child.model ?? "default"} in pane ${child.pane}${this.where(child)}`,
        };
      }

      yield* this.acquire(child, abort).pipe(Effect.tapError(failed));
      yield* this.launch(child, o).pipe(Effect.tapError(failed));
      if (child.status === "blocked") return yield* this.awaitStartup(child, o, abort);
      return yield* this.foreground(child, o.prompt, o.timeoutMs, abort);
    });
  }

  private where(child: Child): string {
    return child.machine ? ` on ${child.machine.label}` : "";
  }

  private resume(o: SpawnOpts, abort: Effect.Effect<void>): Effect.Effect<SpawnResult, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const child = this.lookup(o.resume!);
      if (!child || child.peer) return yield* this.resumePeer(o, abort);
      child.background = o.background;
      const alive = yield* this.hFor(child)
        .agentGet(child.id)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!alive) {
        const session = child.harness === "claude" ? child.sessionId : child.sessionPath;
        if (!session) return yield* new AgentError({ message: `${child.id} is gone and has no session to resume` });
        if (!child.slot) yield* this.acquire(child, abort);
        yield* this.launch(child, o, session).pipe(Effect.tapError((e) => this.fail(child, e)));
        if (child.status === "blocked") return yield* this.awaitStartup(child, o, abort);
      } else if (["starting", "running", "blocked"].includes(child.status)) {
        // A second prompt-wait on a busy child would queue behind its current tool call and race the first watcher.
        return yield* new AgentError({
          message: `${child.id} is ${child.status}; only an idle child can be resumed. SendMessage it instead, with kind=interrupt to stop its current tool call first`,
        });
      } else if (!child.slot) {
        yield* this.acquire(child, abort);
      }
      child.status = "running";
      if (o.background) {
        yield* this.fork(child, this.promptWatch(child, o.prompt, o.timeoutMs));
        return {
          id: child.id,
          status: "running",
          text: `${child.id} resumed with model ${child.model ?? "default"}${this.where(child)}`,
        };
      }
      return yield* this.foreground(child, o.prompt, o.timeoutMs, abort);
    });
  }

  /** Resume an Idle Peer: its Report is delivered here, its lineage is unchanged. */
  private resumePeer(o: SpawnOpts, abort: Effect.Effect<void>): Effect.Effect<SpawnResult, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const p = yield* this.peer(o.resume!, o.background);
      if (p.harness !== "pi" && p.harness !== "claude")
        return yield* new AgentError({
          message: `${p.id} runs ${p.harness}; only pi and claude peers can be resumed, SendMessage it instead`,
        });
      // herdr `done` is a finished turn nobody has looked at yet: as good as idle.
      if (p.status !== "idle" && p.status !== "done")
        return yield* new AgentError({
          message: `${p.id} is ${p.status}; only an idle peer can be resumed, SendMessage it instead`,
        });
      this.children.set(p.id, p);
      yield* this.acquire(p, abort);
      p.status = "running";
      yield* log("peer_resume", { id: p.id, machine: p.machine?.label });
      if (o.background) {
        yield* this.fork(p, this.promptWatch(p, o.prompt, o.timeoutMs));
        return { id: p.id, status: "running", text: `${p.id} resumed${this.where(p)}` };
      }
      return yield* this.foreground(p, o.prompt, o.timeoutMs, abort);
    });
  }

  // ---- foreground / background waiting --------------------------------------

  private foreground(
    child: Child,
    prompt: string | undefined,
    timeoutMs: number,
    abort: Effect.Effect<void>,
  ): Effect.Effect<SpawnResult, AgentError> {
    return Effect.gen({ self: this }, function* () {
      const h = this.hFor(child);
      const wait = prompt ? h.agentPromptWait(this.ref(child), prompt) : h.agentWait(this.ref(child));
      const waited = yield* unlessAborted(
        withTimeout(wait, timeoutMs).pipe(Effect.flatMap((info) => this.settled(child, info, timeoutMs))),
        abort,
      );
      if (Option.isNone(waited)) {
        yield* log("foreground_detach", { id: child.id });
        child.background = true;
        yield* this.fork(child, this.waitWatch(child, timeoutMs));
        return {
          id: child.id,
          status: "detached",
          text: `${child.id} detached with model ${child.model ?? "default"}, keeps running in pane ${child.pane}${this.where(child)}`,
        };
      }
      const r = waited.value;
      if (Result.isSuccess(r)) yield* this.finish(child, r.success);
      else if (isHerdrCode(r.failure, "timeout")) yield* this.timeout(child);
      // herdr gave up observing a transition, but the child may have finished already.
      else if (!(yield* this.stalledToFinish(child, r.failure))) return yield* yield* this.lost(child, r.failure);
      return { id: child.id, status: child.status, text: this.formatReport(child) };
    });
  }

  /**
   * `idle` alone is ambiguous (booting vs finished), so poll the session file:
   * a turn is done only once an assistant message follows the last user message.
   * For a Machine child any herdr error may be a dropped SSH bridge, which gets
   * the same treatment: the child may well have finished meanwhile.
   */
  private stalledToFinish(child: Child, e: AgentError | HerdrError): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      if (e._tag !== "HerdrError") return false;
      if (e.code !== "agent_prompt_stalled" && !child.machine) return false;
      const h = this.hFor(child);
      const deadline = (yield* Clock.currentTimeMillis) + STALL_GRACE_MS;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const info = yield* orUndefined(h.agentGet(this.ref(child)));
        if (!info) return false;
        const path = info.sessionPath ?? child.sessionPath;
        if (path && (yield* this.speaker(child, path)) === "assistant") {
          yield* log("prompt_wait_stalled", { id: child.id, status: info.status });
          yield* this.finish(child, info);
          return true;
        }
        // blocked waits on someone, unknown means the harness is gone from the pane.
        if (info.status === "blocked" || info.status === "unknown") return false;
        yield* Effect.sleep("500 millis");
      }
      yield* log("prompt_wait_stall_timeout", { id: child.id, status: child.status });
      return false;
    });
  }

  /**
   * herdr can report a turn over while the session still ends on a tool call
   * (a dropped state report from the child's hook). Look again after a pause
   * and keep waiting only if herdr then says `working`, so an interrupted
   * turn, which also ends mid tool call, still finishes.
   */
  private settled(child: Child, info: AgentInfo, timeoutMs: number): Effect.Effect<AgentInfo, HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const h = this.hFor(child);
      let cur = info;
      for (;;) {
        const path = cur.sessionPath ?? child.sessionPath;
        if (cur.status === "blocked" || !path) return cur;
        const who = yield* this.speaker(child, path);
        if (!who || who === "assistant") return cur;
        yield* Effect.sleep(SETTLE);
        const now = yield* orUndefined(h.agentGet(this.ref(child)));
        if (now?.status !== "working") return cur;
        yield* log("premature_idle", { id: child.id, status: cur.status, speaker: who });
        cur = yield* withTimeout(h.agentWait(this.ref(child)), timeoutMs);
      }
    });
  }

  private speaker(child: Child, path: string): Effect.Effect<string | undefined> {
    return this.hFor(child)
      .readFile(path)
      .pipe(
        Effect.catch((e) => log("read_session", { id: child.id, path, error: e.message }).pipe(Effect.as(""))),
        Effect.map((raw) => parseLastSpeaker(child.harness, raw)),
      );
  }

  private promptWatch(child: Child, prompt: string, timeoutMs: number): Effect.Effect<void> {
    return this.watcher(child, this.hFor(child).agentPromptWait(this.ref(child), prompt), timeoutMs);
  }

  private waitWatch(child: Child, timeoutMs: number): Effect.Effect<void> {
    return this.watcher(child, this.hFor(child).agentWait(this.ref(child)), timeoutMs);
  }

  /** Wait for the turn to end, record how it ended, deliver the Report. */
  private watcher(
    child: Child,
    op: Effect.Effect<AgentInfo, AgentError | HerdrError>,
    timeoutMs: number,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // A new turn: its Delivery replaces a held one from the turn before.
      this.held.delete(child);
      const r = yield* Effect.result(
        withTimeout(op, timeoutMs).pipe(Effect.flatMap((info) => this.settled(child, info, 0))),
      );
      if (Result.isSuccess(r)) yield* this.finish(child, r.success);
      else if (isHerdrCode(r.failure, "timeout")) yield* this.timeout(child);
      else if (!(yield* this.stalledToFinish(child, r.failure))) yield* this.lost(child, r.failure);
      yield* this.deliver(child);
    });
  }

  /** Run `eff` as `child`'s background fiber, interrupting the one before. */
  private fork(child: Child, eff: Effect.Effect<void>): Effect.Effect<void> {
    return Effect.asVoid(FiberMap.run(this.watchers, child.id, eff));
  }

  // ---- completion -----------------------------------------------------------

  private finish(child: Child, info: AgentInfo): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      child.sessionPath = info.sessionPath ?? child.sessionPath;
      if (info.status === "blocked") {
        child.status = "blocked";
        child.report = yield* this.fromSession(child);
        yield* log("child_blocked", { id: child.id });
        return;
      }
      child.report = yield* this.collect(child);
      const close = this.settings.closeOnDone && !child.peer;
      child.status = close ? "done" : "idle";
      yield* log("child_done", { id: child.id, usage: formatUsage(child.report.usage) });
      yield* this.release(child);
      if (close) yield* this.closePane(child);
    });
  }

  private timeout(child: Child): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      child.status = "timeout";
      child.report = yield* this.collect(child);
      yield* log("child_timeout", { id: child.id });
    });
  }

  private fail(child: Child, e: unknown): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* log("child_failed", { id: child.id, error: messageOf(e) });
      child.status = "killed";
      child.report = {
        text: `failed: ${messageOf(e)}`,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
      };
      yield* this.release(child);
    });
  }

  /**
   * Waiting failed after launch. A local child is treated as failed. A
   * Machine child keeps running out of sight (a dropped bridge is the likely
   * cause), so it goes idle and Resume relaunches it if it is truly gone.
   */
  private lost(child: Child, e: AgentError | HerdrError): Effect.Effect<AgentError> {
    return Effect.gen({ self: this }, function* () {
      // herdr only says the wait failed. The reason (provider outage, bad model
      // id, crash) is on the child's screen, so it travels with the error.
      const screen = child.pane
        ? yield* this.hFor(child)
            .agentRead(this.ref(child), 30)
            .pipe(Effect.orElseSucceed(() => ""))
        : "";
      const err = new AgentError({
        message: `${e.message}${screen.trim() ? `\nlast screen of ${child.id}:\n${screen.trim()}` : ""}`,
      });
      yield* this.fail(child, err);
      if (child.machine || child.peer) child.status = "idle";
      return err;
    });
  }

  private fromSession(child: Child): Effect.Effect<Report | undefined> {
    return Effect.gen({ self: this }, function* () {
      const path = child.sessionPath;
      if (!path) return undefined;
      const raw = yield* this.hFor(child)
        .readFile(path)
        .pipe(Effect.catch((e) => log("read_session", { id: child.id, path, error: e.message }).pipe(Effect.as(""))));
      const r = parseReport(child.harness, raw);
      if (r.model && !child.peer) child.model = r.model;
      return r;
    });
  }

  /** The session Report, or the screen only when the session has no messages at all. */
  private collect(child: Child): Effect.Effect<Report> {
    return Effect.gen({ self: this }, function* () {
      const r = yield* this.fromSession(child);
      if (r?.usage.turns) return r;
      yield* log("report_screen_fallback", { id: child.id, path: child.sessionPath });
      const screen = yield* this.hFor(child)
        .agentRead(this.ref(child), 120)
        .pipe(Effect.orElseSucceed(() => ""));
      return {
        text: `(no session messages found, raw screen follows)\n${screen.trim()}`,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
      };
    });
  }

  private who(child: Child): string {
    const what = child.peer
      ? `peer ${child.id} | ${child.harness}`
      : `subagent ${child.id} | ${child.profile} | ${child.model ?? "default model"}`;
    return `${what}${child.machine ? ` | ${child.machine.label}` : ""} | ${child.status}`;
  }

  formatReport(child: Child): string {
    const r = child.report;
    const head = `[${this.who(child)}${r ? ` | ${formatStats(r)}` : ""}]`;
    const body = r ? r.text || "(no assistant text in the latest turn)" : "(no output)";
    const warn = abnormalStop(r)
      ? `\n(the turn did not finish normally: stop=${r!.stop}${r!.error ? `, ${r!.error}` : ""}${r!.stop === "length" || r!.stop === "max_tokens" ? ", the response was truncated at the output limit" : ""})`
      : "";
    const tail =
      child.status === "blocked"
        ? `\n(${child.id} is waiting for a reply via SendMessage)`
        : child.status === "idle"
          ? `\n(${child.id} is idle: SendMessage to it or Agent resume to continue${child.peer ? "" : ", KillAgent to close"})`
          : "";
    return `${head}\n${body}${warn}${tail}`;
  }

  private deliver(child: Child): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.parent.busy?.()) {
        this.held.add(child);
        return log("deliver_held", { id: child.id });
      }
      return this.parent.deliver(this.formatReport(child), this.settings.notify);
    });
  }

  /** The parent has the Report in hand: a held Delivery would only repeat it. */
  private read(child: Child): Effect.Effect<void> {
    return Effect.suspend(() => (this.held.delete(child) ? log("deliver_dropped", { id: child.id }) : Effect.void));
  }

  /** Send every held Delivery. The parent harness calls this when its turn is about to end. */
  flush(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const held = [...this.held];
      this.held.clear();
      return Effect.forEach(
        held,
        (child) =>
          log("deliver_flush", { id: child.id }).pipe(
            Effect.andThen(this.parent.deliver(this.formatReport(child), this.settings.notify)),
          ),
        { discard: true },
      );
    });
  }

  // ---- inspect / message / kill ---------------------------------------------

  result(
    id: string,
    wait: boolean,
    timeoutMs: number,
    abort: Effect.Effect<void> = Effect.never,
  ): Effect.Effect<string, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const child = this.lookup(id) ?? (yield* this.peer(id));
      if (wait && (child.status === "running" || child.status === "blocked" || child.status === "timeout")) {
        yield* FiberMap.remove(this.watchers, child.id);
        yield* this.read(child);
        return (yield* this.foreground(child, undefined, timeoutMs, abort)).text;
      }
      if (["idle", "done", "killed"].includes(child.status)) {
        // A Peer may have run turns since: reread the session instead of the stored report.
        if (child.status === "idle") child.report = yield* this.collect(child);
        yield* this.read(child);
        return this.formatReport(child);
      }
      const recent = yield* this.hFor(child)
        .agentRead(this.ref(child), 40)
        .pipe(Effect.orElseSucceed(() => ""));
      return `[${this.who(child)} | pane ${child.pane}]\n(${child.id} has not finished: this is its live screen, not a report)\n${recent.trim()}`;
    });
  }

  send(to: string, message: string, kind: "message" | "interrupt" | "keys"): Effect.Effect<void, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const { child, machine, ref } = yield* this.target(to);
      const h = this.hFor({ machine });
      if (kind === "keys") return yield* h.sendKeys(ref, message.split(/\s+/).filter(Boolean));
      if (kind === "interrupt") {
        yield* h.sendKeys(ref, ["esc"]);
        yield* Effect.sleep("300 millis");
      }
      // A Message to an Idle Peer is not a Resume: nothing is delivered back.
      if (child?.status === "idle" && !child.peer) {
        // Resume: a new background turn, the report is delivered when it ends.
        child.status = "running";
        child.background = true;
        yield* this.acquire(child);
        yield* this.fork(child, this.promptWatch(child, message, this.settings.defaultTimeoutMs));
        return;
      }
      yield* h.agentPrompt(ref, message).pipe(
        Effect.catch((e) =>
          Effect.gen(function* () {
            if (!isHerdrCode(e, "agent_blocked")) return yield* e;
            const pane = child?.pane ?? (yield* h.agentGet(ref)).pane;
            yield* log("send_via_pane", { to, pane });
            yield* h.paneRun(pane, message);
          }),
        ),
      );
      if (child && child.status === "blocked") {
        yield* withTimeout(h.agentWaitUntil(ref, ["working", "idle", "done"]), 15_000).pipe(
          Effect.catch((e) => log("unblock_wait", { to, error: e.message })),
        );
        child.status = "running";
        if (child.background) yield* this.fork(child, this.waitWatch(child, this.settings.defaultTimeoutMs));
      }
    });
  }

  kill(id: string): Effect.Effect<void, AgentError> {
    return Effect.gen({ self: this }, function* () {
      const child = this.lookup(id);
      if (!child)
        return yield* new AgentError({ message: `unknown child ${id}: only this session's children can be killed` });
      if (child.peer) return yield* new AgentError({ message: `${id} is a peer: only its parent can kill it` });
      // A queued child's fiber is still in line: interrupting it frees nothing.
      yield* FiberMap.remove(this.watchers, child.id);
      yield* this.closePane(child);
      child.status = "killed";
      yield* this.release(child);
    });
  }

  focus(id: string): Effect.Effect<void, AgentError | HerdrError> {
    return Effect.gen({ self: this }, function* () {
      const { machine, ref } = yield* this.target(id);
      yield* this.hFor({ machine }).agentFocus(ref);
    });
  }
}
