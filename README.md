# picc-grep

Claude Code-style **Grep** (content search) tool for [pi](https://pi.dev) — a faithful port of Claude Code's `Grep` tool, backed by **ripgrep**.

Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.

> pi's built-in `grep` always uses `--json` content mode, has no output modes and no
> multiline support. This extension
> replicates Claude Code's `Grep` exactly: three output modes, rich flags, and
> `head_limit`/`offset` pagination.

## Usage

Install via `pi install npm:@ladbabynpm/picc-grep`.

## Tool

- **Name:** `grep` (default) or `Grep` — configurable (see below).
- **Parameters:** `pattern` (required), plus `path`, `glob`, `type`, `output_mode`
  (`content` | `files_with_matches` (default) | `count`), `-A`, `-B`, `-C`, `context`,
  `-n`, `-i`, `-o`, `head_limit`, `offset`, `multiline`.
- **Behavior:** exact Claude Code arg order
  (`--hidden`, VCS-dir excludes, `--max-columns 500`, mode flags, pattern, `--type`,
  `--glob`), per-mode result templates, path relativization against cwd, and
  `head_limit` (default 250, `0` = unlimited) + `offset` pagination.
- The `-o` (only-matching) parameter is a deliberate extension: it is in the local
  `Grep_schema.json` but not in Claude Code's live source. In content mode it maps to
  `rg -o` / `--only-matching`.
- Requires `rg` (ripgrep) on `PATH`.

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `toolName` | `config.json` | `"grep"` \| `"Grep"` | `"grep"` |
| `PICC_GREP_TOOL_NAME` | env | `"grep"` \| `"Grep"` | — |
| `PICC_GREP_CONFIG_PATH` | env | absolute path to a config.json | sibling of `index.ts` |

Precedence for the tool name: `PICC_GREP_TOOL_NAME` env > `config.json` > `"grep"`.

`config.json` is read from `~/.pi/agent/extensions/picc-grep/config.json` by
default.

```json
{ "toolName": "grep" }
```

## Development

- `npm run lint` — biome check
- `npm run lint:fix` — biome check --write
- `npm run typecheck` — tsc --noEmit

No `any`; top-level imports only; strict TypeScript (ES2022, bundler resolution).
Dependencies beyond `node:*` are limited to `typebox` and
`@earendil-works/pi-coding-agent` (both bundled with pi).

## References

- Claude Code `Grep` tool: `replications/claude-code/tools/GrepTool/GrepTool.ts`
- Claude Code ripgrep: `replications/claude-code/utils/ripgrep.ts`
- Claude Code path helpers: `replications/claude-code/utils/path.ts`
