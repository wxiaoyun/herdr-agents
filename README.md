# herdr-agents

Spawn, message, inspect and kill child coding agents through the [herdr](https://herdr.dev) CLI. Parent and child can each be **pi** or **Claude Code**. Every child is a real interactive session in a herdr pane. Lifecycle (`working`, `idle`, `done`, `blocked`) comes from herdr. The final report is the last assistant message parsed from the child's session file.

Vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Requirements

- Node >= 26
- herdr >= 0.9.1 with the integrations installed for the harnesses you use: `herdr integration install pi`, `herdr integration install claude`
- The parent must run inside a herdr pane. Outside herdr the tools do nothing.

## Install

pi parent:

```
pi install git:github.com/wxiaoyun/herdr-agents
```

Claude Code parent, once per user (path is wherever you cloned or pi installed the repo):

```
claude mcp add -s user herdr -- node <repo>/packages/claude/bin/herdr-agents-mcp.ts
```

Claude Code children spawned by either parent get the MCP server injected automatically and do not need the registration.

## Layout

| Package           | Role                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `packages/core`   | herdr client, child manager, profiles, settings, the five tools        |
| `packages/pi`     | pi extension, the pi parent harness                                    |
| `packages/claude` | Claude Code parent harness: a stdio MCP server exposing the same tools as `mcp__herdr__*` |

## Tools

| Tool                  | Purpose                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`          | Spawn a child. `harness: pi \| claude` picks the child harness (default: profile, then the parent's). Blocks until the child's turn ends and returns its report. `run_in_background: true` returns at once, the report arrives later as a message. `machine: <id or label>` runs the child on a saved herdr machine (see Machines). `resume: <id>` sends another prompt to an existing child, relaunching it from its session if its pane is gone. |
| `GetAgentResult` | Any agent: status plus recent screen, or its latest report (pi and claude). `wait: true` blocks. The screen of an unfinished agent is marked as a live screen, not a report. |
| `SendMessage`    | Text to any agent from `ListAgents`, prefixed `[from <sender id>]`. To an idle child this starts a new turn, the report arrives later as a message. A peer's report does not come back. `to` omitted in a child means the parent. `kind`: `message` (prompt, steers if busy), `interrupt` (esc first), `keys` (raw keys like `enter` or `ctrl+c`). `expect_reply: true` marks the sender `blocked` in herdr until someone replies. |
| `KillAgent`      | Close a child's pane. Never a peer.                                                                                                                                                                                                                                                                                                                              |
| `ListAgents`     | Every agent herdr sees, locally and on enabled saved machines: id, relation (`parent`, `child`, `peer`), harness, status, machine, cwd. `relation` and `status` filter the list. A queued child shows its place in the queue. A killed child whose pane is gone is listed only with `status: killed`. |

Child ids are `<child harness>-<name>-<n>`, for example `claude-scout-2`, unique among the live agents on the child's machine.

A child that stops on a startup dialog (Claude Code's folder trust prompt, a login) pauses until a person answers it in the pane. The parent never answers it. A foreground spawn keeps waiting, a background spawn returns `blocked` at once. The task prompt goes in once the child is idle and the report follows as usual. A child that exits during startup reports that and stays `idle` for `resume`.

A child's turn ends in status `idle`: its pane stays open and it keeps its context. Continue it with `SendMessage` (background) or `Agent` with `resume` (blocks like a spawn). Only an idle child can be resumed: a busy one is refused, steer it with `SendMessage`, `kind: interrupt` to press esc first. Close it with `KillAgent` or by ending the parent session. Set `close_on_done = true` to close panes at the end of every turn instead.

## Placement

Every child gets its own tab in the child workspace: the workspace labelled `<parent workspace label>-agents`, created on first use. A child workspace maps to itself, so grandchildren land in the same one. The label is read once per parent session, since herdr relabels unlabelled workspaces after the focused pane's directory. Nothing is focused on spawn.

In pi, `/agents` lists every agent to focus, message, or (children only) kill one. `/agents send <id> <message>` messages one directly, with ids completed as you type.

## Peers

A peer is any agent that is neither this session's parent nor its child: siblings, grandchildren, agents a person started by hand, even other harnesses herdr detects. Its id is its herdr label, else its pane id, prefixed `<machine>/` off this machine. Any session with these tools can message a peer and `Agent` `resume` an idle pi or claude peer, which delivers that turn's report back like a spawn. Only a parent can kill, and a peer is never relaunched. Parent and child links live in the parent's memory, so after the parent restarts its children show up as peers.

## Machines

`Agent` with `machine` runs the child on another herdr server. The value is the id or label of a profile saved with `herdr machine add`; without saved machines nothing changes. Every herdr call for that child goes through `herdr --machine <id>`, which forwards it over SSH to the remote server. Requirements:

- herdr >= 0.9.1 on both sides (the `--machine` CLI prefix), a running herdr server on the machine, and `ssh <target>` working non-interactively. herdr's own errors say which one is missing.
- The child harness (pi or Claude Code) installed and authenticated on the machine.
- `cwd` exists on the machine. The default is the parent's cwd relative to the local home, which lands at the same place under the remote home, so `/Users/me/code/x` becomes `~/code/x` over there. A parent cwd outside the home is kept as is. herdr silently falls back to `$HOME` for a missing directory, so the spawn checks the pane's cwd and fails instead.

The saved machine labels are listed in the `Agent` description, read once when the parent harness starts. A machine added later still works by name, it is just not listed until restart.

The child's tab lands in the same `<label>-agents` workspace on the machine. Its report is read from its session file over `ssh <target> cat`. A machine child gets no `HERDR_AGENTS_PARENT` and no MCP config, so it cannot spawn or message back; the parent still reaches it with `SendMessage`, `resume` and `KillAgent`. If the SSH bridge drops mid-turn the child goes `idle` with the error as its report; `resume` reattaches, or relaunches it from its session if it is gone. Nothing syncs files or branches between machines.

## Harness differences

| Concern              | pi child                                    | Claude Code child                                                                  |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| model                | `provider/id`, inherits parent when pi      | `anthropic/<id>` loses its prefix, bare ids pass through, other providers error     |
| thinking             | `--thinking` as given                       | `--effort`, `off` and `minimal` become `low`                                       |
| tools                | `--tools` plus the subagent tools           | `--tools` verbatim; builtin profiles are translated (`read` to `Read`, `find` to `Glob`, ...) |
| permissions          | n/a                                         | `--permission-mode auto` (a classifier approves or denies each action, Opus 4.6+ and Sonnet 4.6+ only), `acceptEdits` for models without auto mode (Haiku, Sonnet and Opus up to 4.5). Profile tools also go to `--allowedTools`. Override via `claude_args`. `bypassPermissions` blocks startup on a confirmation |
| native subagents     | none                                        | native `Agent`, `SendMessage`, `ListAgents` stay available, except for profiles that may not spawn (Scout) |
| report into parent   | pi message queue (`notify` setting applies) | typed into the parent's pane as a user message (`notify` ignored)                   |
| `expect_reply`       | herdr shows `blocked`                       | best effort, herdr's screen detection may override                                  |
| resume               | `--session <path>`                          | `--resume <session id>`                                                             |

Cross-harness spawns with no explicit model pass no model, so the child harness uses its own default.

## Profiles

Built in: `general-purpose` (all tools, spawns anything), `Worker` (all tools, may spawn `Scout` only), `Scout` (read-only tools, pick a cheap fast model). User profiles are markdown files in `.pi/agents/`, `.agents/agents/`, or `~/.pi/agent/agents/`. Later locations override earlier ones by name. The same locations serve both parent harnesses.

```markdown
---
name: reviewer
description: Reviews diffs for correctness
harness: claude # optional, pi or claude
model: sonnet
thinking: medium
tools: [Read, Grep, Bash]
prompt_mode: append # or replace
allowed_subagents: [Scout] # or all
---

System prompt body goes here.
```

Tool names in user profiles are passed to the child harness as written. Model and thinking default to the parent's current values when the harness matches.

## Settings

`~/.pi/agent/herdr-agents.toml` then `.pi/herdr-agents.toml` (project wins), read by both parent harnesses. Every key is optional, these are the defaults:

```toml
close_on_done = false
max_concurrent = 4
default_timeout_ms = 0
notify = "follow_up"
max_depth = 2
# default_model = "provider/model"   # unset: inherit the parent model
pi_args = []
claude_args = []
```

An unknown key or a value of the wrong type is dropped and logged as `stage=settings_key`.

- `notify`: `follow_up` injects the background report as a user message and triggers a turn, `passive` appends it for the next turn. pi parent only. While the pi parent runs a turn the report is held until that turn is about to end, and dropped if the parent read it with `GetAgentResult` meanwhile.
- `max_concurrent`: further spawns queue FIFO. Foreground spawns block, background ones return `queued`. Idle children hold no slot.
- Timeout returns the partial report with status `timeout` and leaves the child running.
- Pressing esc during a foreground spawn detaches it: the child keeps running as background.
- `pi_args` / `claude_args`: extra CLI args for every child of that harness, for example `["--no-skills"]` or `["--allowedTools", "Bash(git *)"]`.

Children carry `HERDR_AGENTS_PARENT`, `HERDR_AGENTS_DEPTH`, `HERDR_AGENTS_ID`, `HERDR_AGENTS_PROFILE` and `HERDR_AGENTS_HARNESS` in their environment.

## Debug logging

Logging is on by default and never writes to stdout or stderr. Every parent harness, pi and Claude Code alike, appends to `~/.pi/agent/herdr-agents-debug.log` (under `PI_CODING_AGENT_DIR` when that is set). Each line has a timestamp, the process id and a `stage=` name, so one step is one search:

```sh
rg 'stage=(child_failed|agent_start_failed|premature_idle)' ~/.pi/agent/herdr-agents-debug.log
```

Long values are cut at 300 characters. A file over 5 MB is moved to `herdr-agents-debug.log.1` the next time a session starts. Set `HERDR_AGENTS_LOG=0` to turn logging off, or to a file path to write elsewhere:

```sh
HERDR_AGENTS_LOG=/tmp/herdr-agents.log pi
```

## How a child asks the parent

Child calls `SendMessage({ message, expect_reply: true })`, ends its turn. The text lands in the parent as a queued message prefixed `[from <id>]`. The parent's foreground `Agent` call returns with status `blocked`. Parent answers with `SendMessage({ to: <id>, message })` and resumes waiting with `GetAgentResult({ agent_id, wait: true })`.

## Development

```
npm install
npm test
npm run typecheck
npm run lint
```
