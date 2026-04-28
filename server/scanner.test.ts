import os from "os";
import path from "path";
import { mkdtemp, mkdir, writeFile, symlink } from "fs/promises";
import { describe, expect, it } from "vitest";
import { getDefaults, getLastScanCache, getResourcePreviewById, scanWorkspaceRoots } from "./scanner";

async function setupFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-board-server-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-board-home-"));
  const workspace = path.join(root, "workspace");
  const project = path.join(workspace, "project-a");
  const nested = path.join(project, "apps", "app-one");
  const globalCodex = path.join(home, ".codex");
  const globalClaude = path.join(home, ".claude");
  const globalAgents = path.join(home, ".agents");

  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(nested, ".claude", "commands"), { recursive: true });
  await mkdir(path.join(project, ".codex", "commands"), { recursive: true });
  await mkdir(path.join(globalCodex, "commands"), { recursive: true });
  await mkdir(path.join(globalCodex, "plugins", "sample", "skills", "packaged"), { recursive: true });
  await mkdir(path.join(globalCodex, "plugins", "cache", "openai-bundled", "browser-use"), { recursive: true });
  await mkdir(path.join(globalCodex, "skills", ".system", "builtin"), { recursive: true });
  await mkdir(path.join(globalClaude, "agents"), { recursive: true });
  await mkdir(path.join(globalAgents, "skills", "alpha", "references"), { recursive: true });
  await mkdir(path.join(project, "docs"), { recursive: true });

  await writeFile(path.join(project, "AGENTS.md"), "project agents");
  await writeFile(
    path.join(project, ".codex", "config.toml"),
    ['[mcp_servers.local]', 'command = "node"', '[mcpServers."quoted-name"]', 'command = "node"'].join("\n")
  );
  await writeFile(path.join(project, ".codex", "commands", "deploy.md"), "project deploy");
  await writeFile(path.join(nested, ".claude", "commands", "deploy.md"), "nested deploy");
  await writeFile(path.join(globalCodex, "commands", "deploy.md"), "global deploy");
  await writeFile(path.join(globalCodex, "plugins", "sample", "skills", "packaged", "SKILL.md"), "packaged skill");
  await writeFile(path.join(globalCodex, "plugins", "cache", "openai-bundled", "browser-use", "plugin.json"), "{}");
  await writeFile(path.join(globalCodex, "skills", ".system", "builtin", "SKILL.md"), "builtin skill");
  await writeFile(path.join(globalClaude, "agents", "guide.md"), "global guide");
  await writeFile(path.join(globalAgents, "skills", "alpha", "SKILL.md"), "alpha skill");
  await writeFile(path.join(globalAgents, "skills", "alpha", "references", "notes.md"), "reference notes");
  await writeFile(path.join(project, "docs", "README.md"), "ignored");
  await writeFile(path.join(project, ".codex", "commands", "large.md"), "x".repeat(210 * 1024));
  await symlink(path.join(project, "AGENTS.md"), path.join(project, ".codex", "commands", "link.md"));

  return { root, home, workspace, project, nested, globalCodex, globalClaude };
}

describe("scanner", () => {
  it("returns defaults with sensible fallback paths", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-board-defaults-"));
    await mkdir(path.join(home, "workspace-root"), { recursive: true });
    await mkdir(path.join(home, "workspace-extra"), { recursive: true });

    const defaults = withEnv(
      {
        AGENT_BOARD_DEFAULT_WORKSPACE_ROOT: "~/workspace-root",
        AGENT_BOARD_COMMON_PATHS: "~/workspace-extra"
      },
      () => getDefaults({ homeDir: home })
    );

    expect(defaults.defaultWorkspaceRoot).toBeTruthy();
    expect(defaults.defaultWorkspaceRoot).toBe(path.join(home, "workspace-root"));
    expect(defaults.commonPaths).toEqual([path.join(home, "workspace-extra")]);
  });

  it("scans allowlisted resources, classifies scope, and caches previews", async () => {
    const fixture = await setupFixture();
    const scan = await scanWorkspaceRoots([fixture.workspace, path.join(fixture.root, "missing")], {
      homeDir: fixture.home
    });

    expect(scan.workspaceRoots).toEqual([path.resolve(fixture.workspace)]);
    expect(scan.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(fixture.root, "missing"),
          message: "Scan root is missing or unreadable"
        })
      ])
    );
    expect(scan.resources.some((resource) => resource.path.endsWith(path.join("project-a", "AGENTS.md")))).toBe(true);
    expect(
      scan.resources.some(
        (resource) => resource.kind === "command" && resource.name === "deploy" && resource.path.endsWith("deploy.md")
      )
    ).toBe(true);
    expect(scan.resources.some((resource) => resource.kind === "skill" && resource.name === "alpha")).toBe(true);
    expect(
      scan.resources.some(
        (resource) => resource.kind === "skill" && resource.path.endsWith(path.join("references", "notes.md"))
      )
    ).toBe(false);
    expect(
      scan.resources.some(
        (resource) =>
          resource.kind === "plugin" &&
          resource.path.endsWith(path.join("plugins", "sample", "skills", "packaged", "SKILL.md"))
      )
    ).toBe(true);
    expect(scan.resources.some((resource) => resource.status === "skipped_large")).toBe(true);
    expect(scan.projects).toHaveLength(1);
    expect(scan.relationships.some((relationship) => relationship.type === "inherited_from_global")).toBe(true);
    expect(scan.relationships.some((relationship) => relationship.type === "duplicate_candidate")).toBe(false);
    expect(scan.configurationLoad.baseline).toBe("codex_default_install");
    expect(scan.configurationLoad.excludedDefaultResources).toBeGreaterThan(0);
    expect(scan.configurationLoad.score).toBeGreaterThan(0);
    expect(scan.configurationLoad.categories.find((category) => category.key === "tool_surface")).toEqual(
      expect.objectContaining({
        value: expect.any(Number)
      })
    );
    expect(scan.configurationLoad.categories.find((category) => category.key === "tool_surface")?.detail).toContain("2 MCP servers");
    expect(scan.configurationLoad.topContributors.length).toBeGreaterThan(0);

    const cache = getLastScanCache();
    expect(cache?.resources.length).toBe(scan.resources.length);

    const previewTarget = scan.resources.find((resource) => resource.path === path.join(fixture.project, "AGENTS.md"));
    expect(previewTarget).toBeTruthy();

    const preview = await getResourcePreviewById(previewTarget!.id);
    expect(preview?.content).toContain("project agents");
    expect(preview?.truncated).toBe(false);
  });

  it("deduplicates resources when scan roots overlap", async () => {
    const fixture = await setupFixture();
    const scan = await scanWorkspaceRoots([fixture.workspace, fixture.project], {
      homeDir: fixture.home
    });

    const agentsResources = scan.resources.filter((resource) => resource.path === path.join(fixture.project, "AGENTS.md"));
    expect(agentsResources).toHaveLength(1);
    expect(new Set(scan.resources.map((resource) => resource.id)).size).toBe(scan.resources.length);
    expect(getLastScanCache()?.resources.length).toBe(scan.resources.length);
  });

  it("counts copied git worktree instructions once in load analysis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-board-worktree-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-board-home-"));
    const workspace = path.join(root, "workspace");
    const main = path.join(workspace, "repo");
    const linked = path.join(workspace, "repo-linked");

    await mkdir(path.join(main, ".git", "worktrees", "repo-linked"), { recursive: true });
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(main, "AGENTS.md"), "abcd");
    await writeFile(path.join(linked, "AGENTS.md"), "abcd");
    await writeFile(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "repo-linked")}`);

    const scan = await scanWorkspaceRoots([workspace], { homeDir: home });
    const agentsResources = scan.resources.filter((resource) => resource.kind === "agents_md");
    const promptFootprint = scan.configurationLoad.categories.find((category) => category.key === "prompt_footprint");

    expect(agentsResources).toHaveLength(2);
    expect(agentsResources.filter((resource) => resource.status === "duplicate_candidate")).toHaveLength(1);
    expect(new Set(agentsResources.map((resource) => resource.effectiveResourceKey)).size).toBe(1);
    expect(promptFootprint?.value).toBe(1);
    expect(scan.configurationLoad.topContributors.filter((contributor) => contributor.label === "AGENTS.md (agents_md)")).toHaveLength(1);
    expect(scan.configurationLoad.topContributors.some((contributor) => contributor.label === "Duplicate candidates")).toBe(true);
  });

  it("does not collapse worktree instructions with different content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-board-worktree-diff-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-board-home-"));
    const workspace = path.join(root, "workspace");
    const main = path.join(workspace, "repo");
    const linked = path.join(workspace, "repo-linked");

    await mkdir(path.join(main, ".git", "worktrees", "repo-linked"), { recursive: true });
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(main, "AGENTS.md"), "abcd");
    await writeFile(path.join(linked, "AGENTS.md"), "wxyz");
    await writeFile(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "repo-linked")}`);

    const scan = await scanWorkspaceRoots([workspace], { homeDir: home });
    const agentsResources = scan.resources.filter((resource) => resource.kind === "agents_md");
    const promptFootprint = scan.configurationLoad.categories.find((category) => category.key === "prompt_footprint");

    expect(agentsResources).toHaveLength(2);
    expect(agentsResources.filter((resource) => resource.status === "duplicate_candidate")).toHaveLength(0);
    expect(new Set(agentsResources.map((resource) => resource.effectiveResourceKey)).size).toBe(2);
    expect(promptFootprint?.value).toBe(2);
    expect(scan.configurationLoad.topContributors.filter((contributor) => contributor.label === "AGENTS.md (agents_md)")).toHaveLength(2);
  });

  it("does not collapse same-content nested AGENTS in different subtrees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-board-nested-agents-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-board-home-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "repo");

    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(path.join(project, "apps", "api"), { recursive: true });
    await mkdir(path.join(project, "apps", "web"), { recursive: true });
    await writeFile(path.join(project, "apps", "api", "AGENTS.md"), "same starter");
    await writeFile(path.join(project, "apps", "web", "AGENTS.md"), "same starter");

    const scan = await scanWorkspaceRoots([workspace], { homeDir: home });
    const agentsResources = scan.resources.filter((resource) => resource.kind === "agents_md");
    const promptFootprint = scan.configurationLoad.categories.find((category) => category.key === "prompt_footprint");

    expect(agentsResources).toHaveLength(2);
    expect(agentsResources.filter((resource) => resource.status === "duplicate_candidate")).toHaveLength(0);
    expect(promptFootprint?.value).toBe(6);
  });
});

function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const keys = [
    "AGENT_BOARD_DEFAULT_WORKSPACE_ROOT",
    "AGENT_BOARD_COMMON_PATHS",
    "AGENT_BOARD_HOST",
    "AGENT_BOARD_API_PORT",
    "AGENT_BOARD_CLIENT_PORT"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    if (Object.hasOwn(values, key)) {
      process.env[key] = values[key];
    } else {
      delete process.env[key];
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
