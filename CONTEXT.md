# herdr-agents

Spawns coding-agent processes as herdr panes and relays messages between any agents herdr can see. This context exists to name the parts of that orchestration that span more than one coding agent product.

## Language

**Harness**:
A coding-agent product that runs as an interactive terminal session and that herdr can recognize in a pane. A Child's harness is `pi` or `claude`.
_Avoid_: agent kind, backend, runtime, CLI

**Agent**:
Any session in a herdr pane whose harness herdr recognizes, on the local machine or a saved Machine. Every agent is visible to every other agent that loads this project's tools.
_Avoid_: pane, session (when meaning the agent)

**Parent harness**:
The harness running the parent session, which loads this project's tools. For pi it is the extension. For claude it is the MCP server.
_Avoid_: host, plugin, adapter, integration

**Parent**:
The session that spawned a child. Only the Parent can kill the child. The link lives only in the Parent's memory, so after the Parent restarts its children become Peers.

**Child**:
A session spawned by a parent into its own herdr tab. Has exactly one harness and one Machine, both chosen at spawn time.
_Avoid_: subagent (reserved for the tool name), worker

**Peer**:
Any agent visible to a session that is neither its Parent nor its Child. Includes siblings, grandchildren, and agents a person started by hand. A Peer can be messaged, and Resumed when Idle, but never killed.
_Avoid_: sibling, neighbor, other agent

**Machine**:
A herdr server where an agent lives, named by a saved herdr machine profile. Absent means the local machine. Local agents can reach Machine agents, but a Machine agent cannot reach back and cannot spawn children.
_Avoid_: host, remote, node, server, box

**Profile**:
A named preset for a child: system prompt, tool allowlist, model, effort, and which profiles it may spawn. Harness-neutral by default. May pin a harness.
_Avoid_: agent definition, subagent type, persona

**Message**:
Text typed into another agent's input, carrying the sender's id. Nothing is delivered back; the receiver replies with its own Message if it wants to.

**Report**:
An agent's final assistant text plus usage totals for its latest turn. Any agent can read the Report of a `pi` or `claude` agent, Child or Peer.
_Avoid_: result, output, summary

**Delivery**:
Pushing a Report to the agent that started the turn, when the turn ends. A background turn that outlives its timeout also gets an early Delivery of its partial Report. A spawn or a Resume gets Delivery. A Message does not, except that a Message to an Idle Child counts as a Resume.

**Blocked**:
herdr state meaning an agent is waiting on input from a person or another agent. Reached by a permission prompt or by `expect_reply`.

**Foreground / Background**:
Whether the agent that started a turn waits. Foreground: it waits for the Report. Background: it continues and receives the Report by Delivery later.

**Child workspace**:
The herdr workspace holding every Child's tab, on the Child's Machine. Derived from the parent's workspace label by a fixed rule, and a Child workspace maps to itself, so grandchildren land in the same one.
_Avoid_: placement, split

**Queued**:
A Child waiting for a concurrency slot. It has no pane yet.

**Running**:
An agent in a turn. A Running Child holds a concurrency slot.
_Avoid_: working, busy

**Idle**:
An agent whose turn finished and whose pane stays open. Holds no concurrency slot and can be Resumed. The default end state of a turn.
_Avoid_: done, finished, alive

**Closed**:
A Child whose turn finished and whose pane was then shut because `close_on_done` is set. Resumed by relaunching from its session.
_Avoid_: done

**Killed**:
A Child its Parent killed, or one whose launch or wait failed. Holds no concurrency slot.

**Resume**:
Giving an Idle Child or Peer a new prompt. Starts a new turn that ends in Delivery of its Report to the resumer. A Running or Blocked agent cannot be Resumed, only messaged. If a Child's pane is gone, its Parent relaunches it from its session first. A Peer is never relaunched.
_Avoid_: reuse, continue, follow-up, adopt

**Detached**:
A foreground child the parent stopped waiting on, because the parent aborted or the timeout passed. It continues as a background child.
_Avoid_: timed out (a timeout ends the wait, never the child)

**Stalled**:
A child whose turn finished before herdr observed it working. Recovered by checking the session file.
