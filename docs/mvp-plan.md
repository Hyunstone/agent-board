# Agent Board MVP Plan

Agent Board is a local-only, read-only dashboard for inspecting Codex and Claude
configuration files across multiple workspace roots plus global `~/.codex` and
`~/.claude` directories.

The MVP uses Vite, React, Express, and TypeScript. By default the API binds only
to `127.0.0.1:4317`; Vite runs on `127.0.0.1:5173` and proxies `/api` to the
API. Host, ports, default workspace root, and common path suggestions can be
overridden with environment variables for distribution.

The scanner is metadata-first. It uses allowlist patterns, avoids following
symlinks, skips large previews, stores only the last scan in memory, and loads
resource previews lazily by stable resource id.
