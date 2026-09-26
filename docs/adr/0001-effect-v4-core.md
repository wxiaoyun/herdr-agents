# The core runs on Effect v4, a release candidate

The effectful core (the herdr client, settings and env, logging, the Manager and the tools) is written in Effect v4, pinned to an exact `4.0.0-rc` version while no stable 4.0 exists. The tests needed control over time, env and background watchers that plain Promises could not give without sleeps and `process.env` mutation, and the untyped herdr JSON and string error codes hid bugs. Effect gives all of that through Layers, a TestClock, fibers and Schema.

## Consequences

- Pure parsers (session JSONL, CLI args, report formatting) stay plain functions. The pi extension and the Claude MCP server keep a Promise boundary, bridged by one `ManagedRuntime` per process.
- Nothing imports `effect/unstable/*`. Those modules can break in minor releases and move to stable paths without compatibility exports. Process spawning and file reads go through `node:child_process` and `node:fs` wrapped in Effect instead of the unstable platform modules.
- Every `effect` and `@effect/*` package is bumped together, to one exact version, after reading the changelog, the same way pi is bumped. `deps/effect` holds the matching source.
- `npm run typecheck` patches the local TypeScript with `@effect/language-service` first, so it fails on a floating Effect. Not on install: the pi package install omits dev dependencies, the patcher among them.

## Considered Options

- Stay on Promises and inject time and env by hand. Rejected because it rebuilds half of Effect's runtime in this repo.
- Effect v3, which is stable. Rejected because v4 is where the API is heading and folds platform, schema and the test helpers into one versioned package, so staying on v3 means a second migration later.
