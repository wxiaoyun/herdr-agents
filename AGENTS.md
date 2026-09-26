## Dependency references

Source for pi, herdr and Effect lives in `deps/` as shallow git submodules, pinned to the versions this project targets. Read it there, not in sibling clones, which drift. Run `git submodule update --init` once after cloning. `deps/` is in `.ignore`, so search it explicitly, for example `rg agent_status deps/herdr`.

- `deps/pi`: pi at `v0.87.1`, the version pinned in `package.json`. Bump both together.
- `deps/herdr`: herdr at `v0.9.1`, the minimum version this project supports, because `--machine` needs it. The README states the same floor, change both together. Also read `herdr --skill` and https://herdr.dev/llms.txt for the CLI contract.
- `deps/effect`: Effect at `effect@4.0.0-rc.117`, the version pinned in `packages/core/package.json`. The core runs on Effect v4, see [ADR 0001](docs/adr/0001-effect-v4-core.md). Read `deps/effect/packages/effect/src` and `deps/effect/MIGRATION.md` for the API, most docs online still describe v3. Never import `effect/unstable/*`.
- Claude Code is closed source. Docs index: https://code.claude.com/docs/llms.txt. Pages this project depends on: [permission modes](https://code.claude.com/docs/en/permission-modes.md), [MCP](https://code.claude.com/docs/en/mcp.md), [CLI reference](https://code.claude.com/docs/en/cli-reference.md).

### Keep dependencies current

At the start of any task that touches pi, herdr or Effect behaviour, check for newer releases and bump before building on stale APIs:

- pi: compare `npm view @earendil-works/pi-coding-agent version` with the version in `package.json`. To bump, set `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to the new version, run `npm install`, and move `deps/pi` to the matching `v<version>` tag.
- herdr: compare `git -C deps/herdr log -1` with `git ls-remote https://github.com/herdrdev/herdr.git HEAD` and the locally installed `herdr --version`. Move `deps/herdr` to the commit or release the local build runs, never ahead of it.
- Effect: compare `npm view effect dist-tags.rc` with the version in `packages/core/package.json`. To bump, set `effect`, `@effect/vitest` and every other `@effect/*` package except `@effect/language-service` to the same exact version, run `npm install`, and move `deps/effect` to the matching `effect@<version>` tag. Check `@effect/language-service` for a newer version at the same time.
- Before committing a bump, read the dependency's changelog between the old and new version for breaking changes, then run `npm run typecheck`, `npm test` and the end-to-end check. Commit the bump on its own, with `package.json`, `package-lock.json` and the submodule together.

To move a pin: `git -C deps/<name> fetch --depth 1 origin <tag or commit> && git -C deps/<name> checkout FETCH_HEAD`, then commit the submodule change.

## Tests

Unit tests run on `@effect/vitest`. Build a Manager or the tools with the helpers in `packages/core/test/helpers.ts`, which stub herdr and the parent harness as layers and set env through a ConfigProvider, never `process.env`. `it.effect` runs on a TestClock: fork anything that sleeps, then `TestClock.adjust`. Wait for a background event (a Delivery, a herdr call) on a Queue or Deferred the stub completes, never with a real sleep.

## End-to-end check

After changing how agents are spawned, listed, messaged, resumed or killed, run the live check in [docs/e2e.md](docs/e2e.md) (`node test/e2e.ts`) in addition to `npm test`.
