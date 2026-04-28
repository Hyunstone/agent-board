# Agent Board

Agent Board is a local-only, read-only dashboard for inspecting Codex and
Claude agent configuration across multiple workspace roots.

It helps answer questions like:

- Which skills are registered globally?
- Which projects define local skills or agents?
- Which instruction files, settings, commands, plugins, and automations were
  found?
- For a selected project, which global and project-local resources are likely
  available?

The app is intentionally lightweight: no database, no authentication, no file
editing, and no automatic fixes.

## Features

- Scans Codex and Claude resources from user-provided local workspace roots.
- Includes global config locations such as `~/.codex`, `~/.claude`, and
  `~/.agents` when they exist.
- Shows a visual skill availability board grouped by global, global plus local,
  and project-local skills.
- Shows project context for likely available skills, agents, and instruction
  files.
- Estimates selected-project Codex context impact with likely active
  `AGENTS.md`, configured MCP servers, local candidates, conditional nested
  rules, and lower-confidence global inventory.
- Shows workspace-wide scanned resource load across prompt footprint, tool
  surface, conflict risk, and scope complexity.
- Provides a full inventory table with filters and lazy-loaded previews.
- Stores only the most recent scan in server memory.
- Persists workspace root inputs only in browser `localStorage`.

## Safety Model

Agent Board is designed as a local filesystem viewer.

- The API binds to `127.0.0.1` by default.
- Scans are read-only.
- Symlinks are not followed.
- Large previews are skipped.
- Large, symlinked, binary-like, or unreadable files are not loaded for content
  identity or MCP extraction.
- Preview requests use resource ids from the last scan, not arbitrary file
  paths.
- Workspace roots are not persisted on the server.
- Machine-specific `.env` files are ignored by git.

Keep `AGENT_BOARD_HOST=127.0.0.1` unless you intentionally want to expose a
local filesystem scanner on your network.

## Requirements

- Node.js 22 or newer is recommended.
- npm

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` for your machine:

```bash
AGENT_BOARD_HOST=127.0.0.1
AGENT_BOARD_API_PORT=4317
AGENT_BOARD_CLIENT_PORT=5173
AGENT_BOARD_DEFAULT_WORKSPACE_ROOT=~/path/to/workspaces
AGENT_BOARD_COMMON_PATHS=~/path/to/other/workspaces
# AGENT_BOARD_ALLOW_REMOTE=1
```

If `AGENT_BOARD_DEFAULT_WORKSPACE_ROOT` is not set, the app starts from the
directory where the server process is launched. `~` is expanded using the
current user's home directory.

`AGENT_BOARD_COMMON_PATHS` accepts multiple paths separated by the platform path
delimiter: `:` on macOS/Linux and `;` on Windows.

Non-loopback hosts are refused unless `AGENT_BOARD_ALLOW_REMOTE=1` is set.
Remote exposure is not recommended because the API is a local filesystem
scanner.

## Run

```bash
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

The Express API runs on `127.0.0.1:4317` by default. The Vite dev server runs on
`127.0.0.1:5173` and proxies `/api` to the API.

## Build And Test

```bash
npm test
npm run build
```

The production client build is written to `dist/client`.

## Scanned Resources

Agent Board uses allowlisted patterns instead of recursively indexing every
file.

Codex-oriented resources include:

- `AGENTS.md`, `agents.md`
- `.codex/**`
- `.agents/skills/**/SKILL.md`
- `.agents/plugins/**`
- `.omx/**`
- global `~/.codex/config.toml`
- global `~/.codex/skills/**/SKILL.md`
- global `~/.codex/plugins/**`
- global `~/.codex/automations/**/automation.toml`
- global `~/.agents/skills/**/SKILL.md`

Claude-oriented resources include:

- `CLAUDE.md`, `claude.md`, `.claude.md`
- `.claude/settings.json`
- `.claude/agents/**`
- `.claude/commands/**`
- global `~/.claude/CLAUDE.md`
- global `~/.claude/settings.json`
- global `~/.claude/agents/**`
- global `~/.claude/commands/**`

The scanner excludes common generated directories such as `node_modules`,
`.git`, `dist`, `build`, `.next`, `.turbo`, and `coverage`.

## How Project Detection Works

Resources are found first, then Agent Board tries to associate each resource
with a project.

- If a resource is inside a git repository, the nearest git root becomes the
  project root.
- If no git root is found, the first directory below the configured workspace
  root is used as a fallback project boundary.
- Global resources are shown separately and are considered broadly available to
  scanned projects.

Scope and availability are inferred from file locations. Tool-specific runtime
loading rules can differ by Codex or Claude version, so treat the dashboard as a
high-signal inventory rather than a final execution oracle.

Git worktrees are handled as separate physical scan targets, but exact duplicate
resources from the same repository, same project-relative path, and same content
are collapsed for load analysis and active-context display. Same-content
`AGENTS.md` files in different subtrees are not collapsed because their location
defines their scope.

## UI Guide

Use the top bar to add or remove workspace roots, add suggested common paths,
and run a scan.

The main skill board shows:

- `GLOBAL`: skills found in global locations.
- `GLOBAL + LOCAL`: skills that exist globally and also appear in one or more
  projects.
- `PROJECT LOCAL`: skills found only inside scanned project scopes.

The project context panel shows the resources likely available when working in
the selected project.

The Active Context Impact panel focuses on the selected project:

- `Likely Always Loaded`: ancestor `AGENTS.md` files that apply to the selected
  project path. Project `config.toml` files are treated as runtime
  configuration, not prompt-loaded rule text.
- `Runtime Surface`: configured MCP servers and project-local tool candidates.
  Global skills and plugins are shown as visible inventory, not assumed active.
- Conditional nested rule files are counted separately because they depend on
  the active working directory.

The Workspace Inventory panel is broader. It summarizes all scanned roots and
excludes bundled/default Codex resources where they can be identified. Scores are
static estimates from readable files and discovered configuration, not measured
latency, token usage, or runtime tool registry size.

The inventory table is still available for detailed filtering, path inspection,
status badges, and previewing individual files.

## Configuration Reference

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_BOARD_HOST` | `127.0.0.1` | Host used by both API and Vite dev server. |
| `AGENT_BOARD_API_PORT` | `4317` | Express API port. |
| `AGENT_BOARD_CLIENT_PORT` | `5173` | Vite dev server port. |
| `AGENT_BOARD_DEFAULT_WORKSPACE_ROOT` | server cwd | Initial workspace root shown in the UI. |
| `AGENT_BOARD_COMMON_PATHS` | empty | Suggested workspace roots shown as quick-add buttons. |
| `AGENT_BOARD_ALLOW_REMOTE` | unset | Must be `1` to allow non-loopback hosts. |

## Troubleshooting

If the UI does not load, check whether another process is already using the
client or API port.

If scan results are empty, confirm that the workspace root exists and contains
allowlisted Codex or Claude files.

If a path is missing from suggestions, confirm that the path exists and is
readable. Missing or unreadable paths are skipped instead of failing the whole
scan.

If a preview is unavailable, the file may be too large, unreadable, binary-like,
or no longer present in the latest scan cache.

## Limitations

- No editing, saving, or automatic cleanup.
- No LLM-based semantic analysis.
- No database or historical scan comparison.
- No direct access to the final runtime-loaded instruction stack or tool
  registry. Runtime activation still needs trace/session evidence or measured
  runs.
- Cursor, Windsurf, and other agent ecosystems are not included in the MVP.
- Claude scope is inferred because runtime loading can vary by tool version.
