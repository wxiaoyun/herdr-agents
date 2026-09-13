## Dependency references

Source for pi and herdr lives in `deps/` as shallow git submodules, pinned to the versions this project targets. Read it there, not in sibling clones, which drift. Run `git submodule update --init` once after cloning. `deps/` is in `.ignore`, so search it explicitly, for example `rg agent_status deps/herdr`.

- `deps/pi`: pi at `v0.84.2`, the version pinned in `package.json`. Bump both together.
- `deps/herdr`: the herdr commit the local build runs, after 0.9.0 because `--machine` needs it. Also read `herdr --skill` and https://herdr.dev/llms.txt for the CLI contract.
- Claude Code is closed source. Docs index: https://code.claude.com/docs/llms.txt. Pages this project depends on: [permission modes](https://code.claude.com/docs/en/permission-modes.md), [MCP](https://code.claude.com/docs/en/mcp.md), [CLI reference](https://code.claude.com/docs/en/cli-reference.md).

### Keep dependencies current

At the start of any task that touches pi or herdr behaviour, check for newer releases and bump before building on stale APIs:

- pi: compare `npm view @earendil-works/pi-coding-agent version` with the version in `package.json`. To bump, set `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to the new version, run `npm install`, and move `deps/pi` to the matching `v<version>` tag.
- herdr: compare `git -C deps/herdr log -1` with `git ls-remote https://github.com/herdrdev/herdr.git HEAD` and the locally installed `herdr --version`. Move `deps/herdr` to the commit or release the local build runs, never ahead of it.
- Before committing a bump, read the dependency's changelog between the old and new version for breaking changes, then run `npm run typecheck`, `npm test` and the end-to-end check. Commit the bump on its own, with `package.json`, `package-lock.json` and the submodule together.

To move a pin: `git -C deps/<name> fetch --depth 1 origin <tag or commit> && git -C deps/<name> checkout FETCH_HEAD`, then commit the submodule change.

## End-to-end check

After changing how agents are spawned, listed, messaged, resumed or killed, run the live check in [docs/e2e.md](docs/e2e.md) (`node test/e2e.ts`) in addition to `npm test`.
