## Dependency references

Source for pi, herdr and Effect lives in `deps/` as shallow git submodules, pinned to the versions this project targets. Read it there, not in sibling clones, which drift. Run `git submodule update --init` once after cloning. `deps/` is in `.ignore`, so search it explicitly, for example `rg agent_status deps/herdr`.

- `deps/pi`: pi at `v1.0.1`, the version pinned in `package.json` and the minimum the README states. Typecheck only proves the APIs that exist at the pin, so change all three together.
- `deps/herdr`: herdr at `v0.9.1`, the minimum version this project supports, because `--machine` needs it. The README states the same floor, change both together. Also read `herdr --skill` and https://herdr.dev/llms.txt for the CLI contract.
- `deps/effect`: Effect at `effect@4.0.1`, the version pinned in `packages/core/package.json`. The core runs on Effect v4, see [ADR 0001](docs/adr/0001-effect-v4-core.md). Read `deps/effect/packages/effect/src` and `deps/effect/MIGRATION.md` for the API, most docs online still describe v3. Never import `effect/unstable/*`.
- Claude Code is closed source. Docs index: https://code.claude.com/docs/llms.txt. Pages this project depends on: [permission modes](https://code.claude.com/docs/en/permission-modes.md), [MCP](https://code.claude.com/docs/en/mcp.md), [CLI reference](https://code.claude.com/docs/en/cli-reference.md).

### Keep dependencies current

At the start of any task that touches pi, herdr or Effect behaviour, check for newer releases and bump before building on stale APIs:

- pi: compare `npm view @earendil-works/pi-coding-agent version` and the locally installed `pi --version` with the version in `package.json`. To bump, set `@earendil-works/pi-coding-agent` to the version the local pi runs, never ahead of it, run `bun install`, move `deps/pi` to the matching `v<version>` tag, and raise the pi minimum in the README.
- herdr: compare `git -C deps/herdr log -1` with `git ls-remote --tags https://github.com/herdrdev/herdr.git` and the locally installed `herdr --version`, and read the changelog since the pin. `deps/herdr` stays at the minimum version this project requires, so move it and the README floor only when adopting a feature or fix that needs a newer herdr, and then to the release that introduced it, never ahead of the local build. Releases are cut off a branch, so compare tags by their merge-base, not with `git log <old>..<new>`.
- Effect: compare `npm view effect version` with the version in `packages/core/package.json`. To bump, set `effect`, `@effect/vitest` and every other `@effect/*` package except `@effect/tsgo` to the same exact version, run `bun install`, and move `deps/effect` to the matching `effect@<version>` tag. Check `@effect/tsgo` for a newer version at the same time, and keep `typescript` at a version its README lists as supported.
- Before committing a bump, read the dependency's changelog between the old and new version for breaking changes, then run `bun run typecheck`, `bun run test` and the end-to-end check. Commit the bump on its own, with `package.json`, `bun.lock` and the submodule together.

To move a pin: `git -C deps/<name> fetch --depth 1 origin <tag or commit> && git -C deps/<name> checkout FETCH_HEAD`, then commit the submodule change.

## Tests

Unit tests run on `@effect/vitest`. Build a Manager or the tools with the helpers in `packages/core/test/helpers.ts`, which stub herdr and the parent harness as layers and set env through a ConfigProvider, never `process.env`. `it.effect` runs on a TestClock: fork anything that sleeps, then `TestClock.adjust`. Wait for a background event (a Delivery, a herdr call) on a Queue or Deferred the stub completes, never with a real sleep.

## End-to-end check

After changing how agents are spawned, listed, messaged, resumed or killed, run the live check in [docs/e2e.md](docs/e2e.md) (`node test/e2e.ts`) in addition to `bun run test`.
