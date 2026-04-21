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
  await mkdir(path.join(globalClaude, "agents"), { recursive: true });
  await mkdir(path.join(globalAgents, "skills", "alpha", "references"), { recursive: true });
  await mkdir(path.join(project, "docs"), { recursive: true });

  await writeFile(path.join(project, "AGENTS.md"), "project agents");
  await writeFile(path.join(project, ".codex", "commands", "deploy.md"), "project deploy");
  await writeFile(path.join(nested, ".claude", "commands", "deploy.md"), "nested deploy");
  await writeFile(path.join(globalCodex, "commands", "deploy.md"), "global deploy");
  await writeFile(path.join(globalCodex, "plugins", "sample", "skills", "packaged", "SKILL.md"), "packaged skill");
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
    expect(scan.relationships.some((relationship) => relationship.type === "shadowed_by")).toBe(true);
    expect(scan.relationships.some((relationship) => relationship.type === "inherited_from_global")).toBe(true);
    expect(scan.relationships.some((relationship) => relationship.type === "duplicate_candidate")).toBe(false);

    const cache = getLastScanCache();
    expect(cache?.resources.length).toBe(scan.resources.length);

    const previewTarget = scan.resources.find((resource) => resource.path === path.join(fixture.project, "AGENTS.md"));
    expect(previewTarget).toBeTruthy();

    const preview = await getResourcePreviewById(previewTarget!.id);
    expect(preview?.content).toContain("project agents");
    expect(preview?.truncated).toBe(false);
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
