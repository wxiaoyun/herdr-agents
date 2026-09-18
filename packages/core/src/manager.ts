/**
 * manager.ts: child registry, concurrency queue, spawn / wait / report / kill.
 * All herdr access goes through the injected `Herdr` helper set. A Machine
 * child gets the same helpers bound to its machine.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { childArgs } from "./args.ts";
import {
  type AgentInfo,
  h as defaultHerdr,
  type Herdr,
  HerdrError,
  log,
  type Machine,
} from "./herdr.ts";
import type { Harness, ParentHarness } from "./parent-harness.ts";
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
import type { Settings } from "./settings.ts";

export type ChildStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "idle"
  | "done"
  | "timeout"
  | "killed";

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
  released: boolean;
  watcher?: AbortController;
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

export class Manager {
  readonly children = new Map<string, Child>();
  private counter = 0;
  private live = 0;
  private pending: Array<() => void> = [];

  private pHarness: ParentHarness;
  private settings: Settings;
  private h: Herdr;

  constructor(pHarness: ParentHarness, settings: Settings, h: Herdr = defaultHerdr) {
    this.pHarness = pHarness;
    this.settings = settings;
    this.h = h;
  }

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
  private async target(id: string): Promise<{ child?: Child; machine?: Machine; ref: string }> {
    const child = this.lookup(id);
    if (child) return { child, machine: child.machine, ref: this.ref(child) };
    const slash = id.indexOf("/");
    if (slash < 0) return { ref: id };
    return { machine: await this.machineFor(id.slice(0, slash)), ref: id.slice(slash + 1) };
  }

  /** Every agent herdr sees, locally and on enabled saved machines, except this session. */
  async agents(): Promise<AgentEntry[]> {
    const machines = (await this.h.machineList().catch(() => [])).filter((m) => m.enabled !== false);
    const where: Array<Machine | undefined> = [undefined, ...machines];
    const lists = await Promise.all(
      where.map((machine) =>
        this.hFor({ machine })
          .agentList()
          .catch((e) => {
            log("agent_list", { machine: machine?.label, error: String(e) });
            return [] as AgentInfo[];
          }),
      ),
    );
    const me = process.env.HERDR_PANE_ID;
    const parent = process.env[ENV_PARENT];
    const out: AgentEntry[] = [];
    const seen = new Set<Child>();
    lists.forEach((infos, i) => {
      const machine = where[i];
      for (const a of infos) {
        if (!machine && a.pane === me) continue;
        const ref = a.name ?? a.pane;
        const id = machine ? `${machine.label}/${ref}` : ref;
        const found = this.lookup(id);
        if (found) seen.add(found);
        const child = found && !found.peer ? found : undefined;
        out.push({
          id,
          relation: child ? "child" : !machine && a.pane === parent ? "parent" : "peer",
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
        out.push({ id: this.idOf(c), relation: "child", harness: c.harness, status: c.status, cwd: c.cwd, machine: c.machine, child: c, live: false });
    return out;
  }

  /** A Child-shaped record for a Peer, so Resume and reports reuse the child paths. */
  private async peer(id: string, background = true): Promise<Child> {
    const { machine, ref } = await this.target(id);
    const info = await this.hFor({ machine })
      .agentGet(ref)
      .catch((e) => {
        throw new Error(`unknown agent ${id}: ${String(e)}`);
      });
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
      status: (info.status === "working" ? "running" : info.status) as ChildStatus,
      sessionId: info.sessionId,
      sessionPath: harness
        ? (info.sessionPath ?? sessionPathFor(harness, info.cwd ?? "~", info.sessionId, !!machine))
        : undefined,
      startedAt: Date.now(),
      released: true,
    };
  }

  /** herdr helpers for where this child lives. */
  private hFor(child: { machine?: Machine } | undefined): Herdr {
    return child?.machine ? this.h.machine(child.machine) : this.h;
  }

  // ---- concurrency queue ----------------------------------------------------

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.live < this.settings.maxConcurrent) {
      this.live++;
      return Promise.resolve();
    }
    log("queue_wait", { live: this.live, pending: this.pending.length });
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.pending = this.pending.filter((p) => p !== grant);
        reject(new Error("aborted while queued"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(grant);
    });
  }

  private release(child: Child): void {
    if (child.released) return;
    child.released = true;
    const next = this.pending.shift();
    if (next) next();
    else this.live--;
  }

  // ---- spawn ----------------------------------------------------------------

  private async machineFor(name: string | undefined): Promise<Machine | undefined> {
    if (!name) return undefined;
    const all = await this.h.machineList();
    const found = all.find((m) => m.id === name || m.label === name);
    if (!found)
      throw new Error(
        `unknown machine ${name}. Saved machines: ${all.map((m) => m.label).join(", ") || "none"}`,
      );
    return found;
  }

  /** `<child harness>-<name>-<n>`, unique among the live agents on the child's machine. */
  private async newId(base: string, harness: Harness, h: Herdr): Promise<string> {
    const live = new Set((await h.agentList().catch(() => [])).map((a) => a.name));
    let id: string;
    do {
      this.counter++;
      id = `${harness}-${slug(base)}-${this.counter}`.slice(0, 32);
    } while (this.children.has(id) || live.has(id));
    return id;
  }

  private model(o: SpawnOpts): string | undefined {
    return o.model ?? o.profile.model ?? this.settings.defaultModel ?? undefined;
  }

  private async launch(
    child: Child,
    o: SpawnOpts,
    session?: string,
  ): Promise<void> {
    const h = this.hFor(child);
    child.status = "starting";
    child.model = this.model(o);
    const env = {
      // A Machine child cannot reach the parent's pane, so it gets no parent.
      [ENV_PARENT]: child.machine ? "" : (process.env.HERDR_PANE_ID ?? ""),
      [ENV_DEPTH]: String(o.depth),
      [ENV_ID]: child.id,
      [ENV_PROFILE]: o.profile.name,
      [ENV_HARNESS]: o.harness,
    };
    [child.pane, child.cwd] = await this.place(child, o.cwd, env);
    // herdr cannot pass args containing newlines; stage multi-line profile
    // prompts in a temp file (pi reads the path at startup) and clean up after
    // the child is interactive.
    // A Machine child reads a copy under /tmp over there.
    const staged = mkdtempSync(join(tmpdir(), "herdr-agents-"));
    const stagedAs = child.machine ? `/tmp/${basename(staged)}` : staged;
    try {
      const args = childArgs(
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
      );
      await h.stage(staged, stagedAs);
      await h.agentStart(child.id, child.pane, o.harness, args);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_ready") {
        // A startup dialog (folder trust, login). herdr keeps the pane and
        // the name; the prompt goes in once someone answers it.
        log("agent_start_blocked", { id: child.id, pane: child.pane });
        child.status = "blocked";
        return;
      }
      log("agent_start_failed", { id: child.id, error: String(e) });
      await this.closePane(child);
      throw e;
    } finally {
      rmSync(staged, { recursive: true, force: true });
      await h.unstage(stagedAs);
    }
    await this.learnSession(child, o);
  }

  private async learnSession(child: Child, o: SpawnOpts): Promise<AgentInfo | undefined> {
    const info = await this.hFor(child)
      .agentGet(child.id)
      .catch(() => undefined);
    child.sessionId = info?.sessionId;
    child.sessionPath =
      info?.sessionPath ??
      sessionPathFor(o.harness, child.cwd ?? o.cwd, info?.sessionId, !!child.machine);
    child.status = "running";
    log("launched", {
      id: child.id,
      pane: child.pane,
      machine: child.machine?.label,
      session: child.sessionPath,
    });
    return info;
  }

  /**
   * The child sits on a startup dialog (folder trust, login). Only a person
   * answers it, never the parent: the child pauses until it is idle, then the
   * task prompt goes in. Foreground keeps waiting, background returns
   * `blocked` and delivers the report later.
   */
  private async awaitStartup(
    child: Child,
    o: SpawnOpts,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const settle = async (s?: AbortSignal) => {
      await this.hFor(child).agentWaitUntil(child.id, ["idle"], o.timeoutMs, s);
      if (!(await this.learnSession(child, o)))
        throw new Error(`${child.id} exited during startup (the dialog was probably declined)`);
    };
    if (!o.background) {
      try {
        await settle(signal);
      } catch (e) {
        if (signal?.aborted) {
          log("startup_detach", { id: child.id });
          child.background = true;
          return this.awaitStartup(child, { ...o, background: true });
        }
        throw await this.lost(child, e);
      }
      return this.foreground(child, o.prompt, o.timeoutMs, signal);
    }
    this.spawnWatcher(child, async (s) => {
      await settle();
      return this.hFor(child).agentPromptWait(child.id, o.prompt, o.timeoutMs, s);
    });
    return {
      id: child.id,
      status: "blocked",
      text: `${child.id} is waiting on a startup prompt in pane ${child.pane}${this.where(child)} (folder trust, login, or similar). A person has to answer it in the pane. The task prompt is sent once the child is idle and its report arrives as a message.`,
    };
  }

  // ---- placement ------------------------------------------------------------

  /**
   * A tab in the child workspace. herdr silently falls back to $HOME when the
   * cwd is missing (the usual case on a Machine), so the returned cwd is checked.
   */
  private async place(
    child: Child,
    cwd: string,
    env: Record<string, string>,
  ): Promise<[string, string]> {
    const h = this.hFor(child);
    const ws = await this.childWorkspace(child, cwd);
    const made = await h.tabCreate(child.id, cwd, env, ws).catch(async (e) => {
      // Someone closed the cached child workspace: resolve it again, once.
      if (!(e instanceof HerdrError && e.code === "workspace_not_found")) throw e;
      log("child_workspace_stale", { id: ws, machine: child.machine?.label });
      this.childWs.delete(child.machine?.id ?? "");
      return h.tabCreate(child.id, cwd, env, await this.childWorkspace(child, cwd));
    });
    // ponytail: exact string compare; a symlinked cwd (macOS /tmp) would trip
    // it, resolve both sides if that bites.
    if (!sameDir(made.cwd, cwd)) {
      child.pane = made.pane;
      await this.closePane(child);
      child.pane = undefined;
      throw new Error(
        `cwd ${cwd} does not exist on ${child.machine?.label ?? "this machine"} (herdr fell back to ${made.cwd})`,
      );
    }
    return [made.pane, made.cwd];
  }

  private childWs = new Map<string, string>();

  /**
   * herdr relabels an unlabelled workspace after the focused pane's cwd, so
   * the derived label can drift mid-session. Resolve once per parent process
   * and per machine. The label comes from the parent's own workspace.
   */
  private async childWorkspace(child: Child, cwd: string): Promise<string | undefined> {
    const mine = process.env.HERDR_WORKSPACE_ID;
    if (!mine) return undefined;
    const key = child.machine?.id ?? "";
    let ws = this.childWs.get(key);
    if (!ws) {
      const label = childWorkspaceLabel(await this.h.workspaceLabel(mine));
      ws = await this.hFor(child).workspaceByLabel(label, cwd);
      this.childWs.set(key, ws);
      log("child_workspace", { label, id: ws, machine: child.machine?.label });
    }
    return ws;
  }

  private async closePane(child: Child): Promise<void> {
    if (!child.pane) return;
    await this.hFor(child)
      .paneClose(child.pane)
      .catch((e) => log("pane_close", { id: child.id, error: String(e) }));
  }

  async spawn(o: SpawnOpts, signal?: AbortSignal): Promise<SpawnResult> {
    if (o.depth > this.settings.maxDepth) {
      throw new Error(`max nesting depth ${this.settings.maxDepth} reached`);
    }
    if (o.resume) return this.resume(o, signal);

    const machine = await this.machineFor(o.machine);
    const child: Child = {
      id: await this.newId(o.name ?? o.profile.name, o.harness, this.hFor({ machine })),
      profile: o.profile.name,
      harness: o.harness,
      machine,
      model: this.model(o),
      description: o.description,
      background: o.background,
      status: "queued",
      startedAt: Date.now(),
      released: false,
    };
    this.children.set(child.id, child);

    const run = async () => {
      // Killed while queued: hand the slot on instead of launching.
      if (child.status === "killed") return this.release(child);
      await this.launch(child, o);
      if (child.status === "blocked") await this.awaitStartup(child, o);
      else this.watchPrompt(child, o.prompt, o.timeoutMs);
    };

    if (o.background) {
      if (this.live >= this.settings.maxConcurrent) {
        void this.acquire()
          .then(run)
          .catch((e) => this.fail(child, e));
        return {
          id: child.id,
          status: "queued",
          text: `${child.id} queued with model ${child.model ?? "default"} (${this.live}/${this.settings.maxConcurrent} slots busy)`,
        };
      }
      await this.acquire();
      await this.launch(child, o).catch((e) => {
        this.fail(child, e);
        throw e;
      });
      if (child.status === "blocked") return this.awaitStartup(child, o);
      this.watchPrompt(child, o.prompt, o.timeoutMs);
      return {
        id: child.id,
        status: "running",
        text: `${child.id} started with model ${child.model ?? "default"} in pane ${child.pane}${this.where(child)}`,
      };
    }

    await this.acquire(signal);
    await this.launch(child, o).catch((e) => {
      this.fail(child, e);
      throw e;
    });
    if (child.status === "blocked") return this.awaitStartup(child, o, signal);
    return this.foreground(child, o.prompt, o.timeoutMs, signal);
  }

  private where(child: Child): string {
    return child.machine ? ` on ${child.machine.label}` : "";
  }

  private async resume(
    o: SpawnOpts,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const child = this.lookup(o.resume!);
    if (!child || child.peer) return this.resumePeer(o, signal);
    child.background = o.background;
    const alive = await this.hFor(child)
      .agentGet(child.id)
      .then(
        () => true,
        () => false,
      );
    if (!alive) {
      const session =
        child.harness === "claude" ? child.sessionId : child.sessionPath;
      if (!session)
        throw new Error(`${child.id} is gone and has no session to resume`);
      await this.acquire(signal);
      child.released = false;
      await this.launch(child, o, session).catch((e) => {
        this.fail(child, e);
        throw e;
      });
      if (child.status === "blocked") return this.awaitStartup(child, o, signal);
    } else if (["starting", "running", "blocked"].includes(child.status)) {
      // A second prompt-wait on a busy child would queue behind its current tool call and race the first watcher.
      throw new Error(
        `${child.id} is ${child.status}; only an idle child can be resumed. SendMessage it instead, with kind=interrupt to stop its current tool call first`,
      );
    } else if (child.released) {
      await this.acquire(signal);
      child.released = false;
    }
    child.status = "running";
    if (o.background) {
      this.watchPrompt(child, o.prompt, o.timeoutMs);
      return {
        id: child.id,
        status: "running",
        text: `${child.id} resumed with model ${child.model ?? "default"}${this.where(child)}`,
      };
    }
    return this.foreground(child, o.prompt, o.timeoutMs, signal);
  }

  /** Resume an Idle Peer: its Report is delivered here, its lineage is unchanged. */
  private async resumePeer(o: SpawnOpts, signal?: AbortSignal): Promise<SpawnResult> {
    const p = await this.peer(o.resume!, o.background);
    if (p.harness !== "pi" && p.harness !== "claude")
      throw new Error(`${p.id} runs ${p.harness}; only pi and claude peers can be resumed, SendMessage it instead`);
    // herdr `done` is a finished turn nobody has looked at yet: as good as idle.
    if (p.status !== "idle" && p.status !== "done")
      throw new Error(`${p.id} is ${p.status}; only an idle peer can be resumed, SendMessage it instead`);
    this.children.set(p.id, p);
    await this.acquire(signal);
    p.released = false;
    p.status = "running";
    log("peer_resume", { id: p.id, machine: p.machine?.label });
    if (o.background) {
      this.watchPrompt(p, o.prompt, o.timeoutMs);
      return { id: p.id, status: "running", text: `${p.id} resumed${this.where(p)}` };
    }
    return this.foreground(p, o.prompt, o.timeoutMs, signal);
  }

  // ---- foreground / background waiting --------------------------------------

  private async foreground(
    child: Child,
    prompt: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const h = this.hFor(child);
    try {
      const info = prompt
        ? await h.agentPromptWait(this.ref(child), prompt, timeoutMs, signal)
        : await h.agentWait(this.ref(child), timeoutMs, signal);
      await this.finish(child, await this.settled(child, info, timeoutMs, signal));
    } catch (e) {
      if (signal?.aborted) {
        log("foreground_detach", { id: child.id });
        child.background = true;
        this.watch(child, timeoutMs);
        return {
          id: child.id,
          status: "detached",
          text: `${child.id} detached with model ${child.model ?? "default"}, keeps running in pane ${child.pane}${this.where(child)}`,
        };
      }
      if (e instanceof HerdrError && e.code === "timeout") {
        await this.timeout(child);
      } else if (await this.stalledToFinish(child, e)) {
        // herdr gave up observing a transition, but the child already finished.
      } else {
        throw await this.lost(child, e);
      }
    }
    return {
      id: child.id,
      status: child.status,
      text: this.formatReport(child),
    };
  }

  /**
   * herdr `agent prompt --wait` errors with `agent_prompt_stalled` when the
   * whole turn completes before it observes a working/blocked state. `idle`
   * alone is ambiguous (booting vs finished), so poll the session file: a turn
   * is done only once an assistant message follows the last user message.
   * For a Machine child any herdr error may be a dropped SSH bridge, which
   * gets the same treatment: the child may well have finished meanwhile.
   */
  stallGraceMs = 30_000;

  private async stalledToFinish(child: Child, e: unknown): Promise<boolean> {
    if (!(e instanceof HerdrError)) return false;
    if (e.code !== "agent_prompt_stalled" && !child.machine) return false;
    const h = this.hFor(child);
    const deadline = Date.now() + this.stallGraceMs;
    while (Date.now() < deadline) {
      const info = await h.agentGet(this.ref(child)).catch(() => undefined);
      if (!info) return false;
      const path = info.sessionPath ?? child.sessionPath;
      if (path && (await this.speaker(child, path)) === "assistant") {
        log("prompt_wait_stalled", { id: child.id, status: info.status });
        await this.finish(child, info);
        return true;
      }
      if (info.status === "blocked" || info.status === "failed") return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    log("prompt_wait_stall_timeout", { id: child.id, status: child.status });
    return false;
  }

  /**
   * herdr can report a turn over while the session still ends on a tool call
   * (a dropped state report from the child's hook). Look again after a pause
   * and keep waiting only if herdr then says `working`, so an interrupted
   * turn, which also ends mid tool call, still finishes.
   */
  settleMs = 2000;

  private async settled(
    child: Child,
    info: AgentInfo,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentInfo> {
    const h = this.hFor(child);
    for (;;) {
      const path = info.sessionPath ?? child.sessionPath;
      if (info.status === "blocked" || !path) return info;
      const who = await this.speaker(child, path);
      if (!who || who === "assistant") return info;
      await new Promise((r) => setTimeout(r, this.settleMs));
      const now = await h.agentGet(this.ref(child)).catch(() => undefined);
      if (now?.status !== "working") return info;
      log("premature_idle", { id: child.id, status: info.status, speaker: who });
      info = await h.agentWait(this.ref(child), timeoutMs, signal);
    }
  }

  private async speaker(child: Child, path: string): Promise<string | undefined> {
    const raw = await this.hFor(child)
      .readFile(path)
      .catch((e) => {
        log("read_session", { id: child.id, path, error: String(e) });
        return "";
      });
    return parseLastSpeaker(child.harness, raw);
  }

  private watchPrompt(child: Child, prompt: string, timeoutMs: number): void {
    this.spawnWatcher(
      child,
      (signal) =>
        this.hFor(child).agentPromptWait(this.ref(child), prompt, timeoutMs, signal),
    );
  }

  private watch(child: Child, timeoutMs: number): void {
    this.spawnWatcher(
      child,
      (signal) => this.hFor(child).agentWait(this.ref(child), timeoutMs, signal),
    );
  }

  private spawnWatcher(
    child: Child,
    op: (signal: AbortSignal) => Promise<AgentInfo>,
  ): void {
    child.watcher?.abort();
    const ac = new AbortController();
    child.watcher = ac;
    void op(ac.signal)
      .then(async (info) => this.finish(child, await this.settled(child, info, 0, ac.signal)))
      .catch(async (e) => {
        if (ac.signal.aborted) return;
        if (e instanceof HerdrError && e.code === "timeout")
          await this.timeout(child);
        else if (await this.stalledToFinish(child, e)) return;
        else await this.lost(child, e);
      })
      .then(() => {
        if (!ac.signal.aborted) this.deliver(child);
      });
  }

  // ---- completion -----------------------------------------------------------

  private async finish(child: Child, info: AgentInfo): Promise<void> {
    child.sessionPath = info.sessionPath ?? child.sessionPath;
    if (info.status === "blocked") {
      child.status = "blocked";
      child.report = await this.fromSession(child);
      log("child_blocked", { id: child.id });
      return;
    }
    child.report = await this.collect(child);
    const close = this.settings.closeOnDone && !child.peer;
    child.status = close ? "done" : "idle";
    log("child_done", { id: child.id, usage: formatUsage(child.report.usage) });
    this.release(child);
    if (close) await this.closePane(child);
  }

  private async timeout(child: Child): Promise<void> {
    child.status = "timeout";
    child.report = await this.collect(child);
    log("child_timeout", { id: child.id });
  }

  private fail(child: Child, e: unknown): void {
    log("child_failed", { id: child.id, error: String(e) });
    child.status = "killed";
    child.report = {
      text: `failed: ${String(e)}`,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
    this.release(child);
  }

  /**
   * Waiting failed after launch. A local child is treated as failed. A
   * Machine child keeps running out of sight (a dropped bridge is the likely
   * cause), so it goes idle and Resume relaunches it if it is truly gone.
   */
  private async lost(child: Child, e: unknown): Promise<Error> {
    // herdr only says the wait failed. The reason (provider outage, bad model
    // id, crash) is on the child's screen, so it travels with the error.
    const screen = child.pane
      ? await this.hFor(child)
          .agentRead(this.ref(child), 30)
          .catch(() => "")
      : "";
    const err = new Error(
      `${String(e)}${screen.trim() ? `\nlast screen of ${child.id}:\n${screen.trim()}` : ""}`,
    );
    this.fail(child, err);
    if (child.machine || child.peer) child.status = "idle";
    return err;
  }

  private async fromSession(child: Child): Promise<Report | undefined> {
    if (!child.sessionPath) return undefined;
    const raw = await this.hFor(child)
      .readFile(child.sessionPath)
      .catch((e) => {
        log("read_session", { id: child.id, path: child.sessionPath, error: String(e) });
        return "";
      });
    const r = parseReport(child.harness, raw);
    if (r.model && !child.peer) child.model = r.model;
    return r;
  }

  /** The session Report, or the screen only when the session has no messages at all. */
  private async collect(child: Child): Promise<Report> {
    const r = await this.fromSession(child);
    if (r?.usage.turns) return r;
    log("report_screen_fallback", { id: child.id, path: child.sessionPath });
    const screen = await this.hFor(child)
      .agentRead(this.ref(child), 120)
      .catch(() => "");
    return {
      text: `(no session messages found, raw screen follows)\n${screen.trim()}`,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
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

  private deliver(child: Child): void {
    this.pHarness.deliver(this.formatReport(child), this.settings.notify);
  }

  // ---- inspect / message / kill ---------------------------------------------

  async result(
    id: string,
    wait: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const child = this.lookup(id) ?? (await this.peer(id));
    if (
      wait &&
      (child.status === "running" ||
        child.status === "blocked" ||
        child.status === "timeout")
    ) {
      child.watcher?.abort();
      child.watcher = undefined;
      return (await this.foreground(child, undefined, timeoutMs, signal)).text;
    }
    if (["idle", "done", "killed"].includes(child.status)) {
      // A Peer may have run turns since: reread the session instead of the stored report.
      if (child.status === "idle") child.report = await this.collect(child);
      return this.formatReport(child);
    }
    const recent = await this.hFor(child)
      .agentRead(this.ref(child), 40)
      .catch(() => "");
    return `[${this.who(child)} | pane ${child.pane}]\n(${child.id} has not finished: this is its live screen, not a report)\n${recent.trim()}`;
  }

  async send(
    to: string,
    message: string,
    kind: "message" | "interrupt" | "keys",
  ): Promise<void> {
    const { child, machine, ref } = await this.target(to);
    const h = this.hFor({ machine });
    if (kind === "keys") {
      await h.sendKeys(ref, message.split(/\s+/).filter(Boolean));
      return;
    }
    if (kind === "interrupt") {
      await h.sendKeys(ref, ["esc"]);
      await new Promise((r) => setTimeout(r, 300));
    }
    // A Message to an Idle Peer is not a Resume: nothing is delivered back.
    if (child?.status === "idle" && !child.peer) {
      // Resume: a new background turn, the report is delivered when it ends.
      child.status = "running";
      child.background = true;
      child.released = false;
      await this.acquire();
      this.watchPrompt(child, message, this.settings.defaultTimeoutMs);
      return;
    }
    try {
      await h.agentPrompt(ref, message);
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === "agent_blocked")) throw e;
      const pane = child?.pane ?? (await h.agentGet(ref)).pane;
      log("send_via_pane", { to, pane });
      await h.paneRun(pane, message);
    }
    if (child && child.status === "blocked") {
      await h
        .agentWaitUntil(ref, ["working", "idle", "done"], 15000)
        .catch((e) => log("unblock_wait", { to, error: String(e) }));
      child.status = "running";
      if (child.background) this.watch(child, this.settings.defaultTimeoutMs);
    }
  }

  async kill(id: string): Promise<void> {
    const child = this.lookup(id);
    if (!child) throw new Error(`unknown child ${id}: only this session's children can be killed`);
    if (child.peer) throw new Error(`${id} is a peer: only its parent can kill it`);
    child.watcher?.abort();
    await this.closePane(child);
    // A queued child holds no slot yet: its turn in the queue releases it.
    const queued = child.status === "queued";
    child.status = "killed";
    if (!queued) this.release(child);
  }

  async focus(id: string): Promise<void> {
    const { machine, ref } = await this.target(id);
    await this.hFor({ machine }).agentFocus(ref);
  }
}
