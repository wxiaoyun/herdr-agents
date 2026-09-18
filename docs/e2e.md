# End-to-end check

The unit tests stub herdr. This check runs the tools against real herdr, pi and Claude Code, locally and on a saved machine. Run it after any change to how agents are spawned, listed, messaged, resumed or killed.

## Prerequisites

- Run it from a herdr pane in this checkout. The tools need `HERDR_PANE_ID`, and the pi child treats that pane as its parent.
- pi loads the extension from this checkout, not the git install. `.pi/settings.json` does that by loading `../` and excluding the git package by its source URL. If the URL there does not match your installed source, pi loads both copies, fails on tool name conflicts and exits, and the spawn times out with `timed out waiting for agent startup`.
- At least one enabled saved herdr machine (`herdr machine list`) with Claude Code installed and authenticated. Remote children start in `~`, since this checkout may not exist over there.
- Your default pi model and the Claude model below cost a few cents per run.

## Run

```
node test/e2e.ts
```

| Env | Default |
| --- | --- |
| `E2E_MACHINE` | first enabled saved machine |
| `E2E_CLAUDE_MODEL` | `claude-haiku-4-5` |
| `E2E_PI_MODEL` | pi's default model |
| `HERDR_AGENTS_LOG` | unset: every herdr call is logged to `~/.pi/agent/herdr-agents-debug.log`. Set a file path to log elsewhere, `0` to turn it off |

It prints one `PASS` or `FAIL` line per check and exits non-zero on any failure. It takes about two minutes. Both children are killed at the end, even on failure.

## What it covers

Two tool sets in one process stand in for two sessions. Session A spawns a local pi child and a remote Claude child. Session B has spawned nothing, so it sees both as peers.

| Check | Proves |
| --- | --- |
| A spawns both children and gets `PONG-1`, `PONG-2` | local and Machine spawn, foreground reports |
| A lists both as `child`, B lists both as `peer`, each exactly once | relations, `<machine>/<id>` ids, no duplicate entries |
| B resumes each peer and gets `PONG-3`, `PONG-4` | Resume of an Idle Peer, with Delivery to the resumer |
| B reads the remote peer's report, A reads its child's newest one | GetAgentResult on any agent, no stale reports |
| B's kill and B's resume of a busy peer both fail | only a Parent kills, only an Idle Peer is resumed |
| The pi child runs `ListAgents` and messages the remote agent | the extension in a child, `[from <id>]` prefix, messages across machines |
| `/agents send` in the pi child shows the remote id as a completion, then delivers | the pi command and its completion |

## Debugging a failure

- A `FAIL` line prints the tool output or screen it checked.
- To see what a child did, run `herdr agent read <id> --source recent-unwrapped --lines 80`. Add `--machine <label>` before `agent` for a remote child.
- If a run dies before cleanup, list leftovers with `herdr agent list` (add `--machine <label>` for the remote side) and close them with `herdr pane close <pane>`.
