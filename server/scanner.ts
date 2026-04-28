import fg from "fast-glob";
import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, statSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { getCommonWorkspaceRoots, getDefaultWorkspaceRoot } from "./config";
import type {
  AgentResource,
  ConfigurationLoadAnalysis,
  DefaultsResponse,
  Ecosystem,
  LoadCategory,
  LoadContributor,
  LoadLevel,
  Project,
  ProjectLoadSummary,
  Relationship,
  ResourceKind,
  ResourcePreview,
  ResourceScope,
  ResourceStatus,
  ScanResult,
  ScanWarning,
  ScopeConfidence
} from "../shared/types";

export interface ScannerOptions {
  homeDir?: string;
  previewLimitBytes?: number;
}

interface ScannedResource extends AgentResource {
  signature: string;
  contentIdentity?: string;
  relativePathFromProject?: string;
  projectRoot?: string;
  workspaceRoot?: string;
  repositoryKey?: string;
  detectedBy?: Project["detectedBy"];
  previewLimitBytes: number;
}

interface ScanCache {
  scannedAt: string;
  resources: ScannedResource[];
  resourceById: Map<string, ScannedResource>;
}

interface ProjectLocation {
  projectRoot: string;
  workspaceRoot: string;
  detectedBy: Project["detectedBy"];
}

const DEFAULT_PREVIEW_LIMIT_BYTES = 200 * 1024;
const GLOBAL_DIRS = [".codex", ".claude", ".agents"];
const EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "cache",
  "tmp",
  "temp",
  ".venv",
  "venv",
  "site-packages"
];
const ALLOWLIST_PATTERNS = [
  "**/AGENTS.md",
  "**/agents.md",
  "**/CLAUDE.md",
  "**/claude.md",
  "**/.claude.md",
  "**/.codex/**/*.{md,json,toml,yaml,yml,js,ts}",
  "**/.claude/**/*.{md,json,toml,yaml,yml,js,ts}",
  "**/.agents/skills/**/SKILL.md",
  "**/.agents/plugins/**/*.{md,json,toml,yaml,yml,js,ts}",
  "**/.omx/**/*.{md,json,toml,yaml,yml,js,ts}"
];
const GLOBAL_ALLOWLIST_PATTERNS = [
  "**/AGENTS.md",
  "**/agents.md",
  "**/CLAUDE.md",
  "**/claude.md",
  "**/.claude.md",
  "config.toml",
  "settings.json",
  "skills/**/SKILL.md",
  "commands/**/*.{md,json,toml,yaml,yml,js,ts}",
  "agents/**/*.{md,json,toml,yaml,yml,js,ts}",
  "subagents/**/*.{md,json,toml,yaml,yml,js,ts}",
  "plugins/**/*.{md,json,toml,yaml,yml,js,ts}",
  "automations/**/automation.toml"
];
const PROMPT_LOAD_KINDS = new Set<ResourceKind>(["agents_md", "claude_md", "setting", "omx", "automation"]);
const TOOL_LOAD_KINDS = new Set<ResourceKind>(["skill", "command", "subagent", "plugin", "mcp"]);
const CONFLICT_RELATIONSHIP_TYPES = new Set(["duplicate_candidate", "shadows", "shadowed_by"]);

let lastScanCache: ScanCache | null = null;

export function getDefaults(options: ScannerOptions = {}): DefaultsResponse {
  const homeDir = resolveAbsolutePath(options.homeDir ?? os.homedir());
  const configuredDefaultWorkspaceRoot = getDefaultWorkspaceRoot(homeDir);
  const defaultWorkspaceRoot = configuredDefaultWorkspaceRoot
    ? resolveAbsolutePath(configuredDefaultWorkspaceRoot)
    : null;
  const cwd = resolveAbsolutePath(process.cwd());
  const commonPaths = getCommonWorkspaceRoots(homeDir).map(resolveAbsolutePath).filter(statAcceptsDirectory);
  const codexPath = path.join(homeDir, ".codex");
  const claudePath = path.join(homeDir, ".claude");
  const agentsPath = path.join(homeDir, ".agents");

  return {
    defaultWorkspaceRoot: defaultWorkspaceRoot && statAcceptsDirectory(defaultWorkspaceRoot) ? defaultWorkspaceRoot : cwd,
    commonPaths,
    globals: {
      codex: {
        path: codexPath,
        exists: statAcceptsDirectory(codexPath)
      },
      claude: {
        path: claudePath,
        exists: statAcceptsDirectory(claudePath)
      },
      agents: {
        path: agentsPath,
        exists: statAcceptsDirectory(agentsPath)
      }
    }
  };
}

export async function scanWorkspaceRoots(
  workspaceRoots: string[],
  options: ScannerOptions = {}
): Promise<ScanResult> {
  const homeDir = resolveAbsolutePath(options.homeDir ?? os.homedir());
  const previewLimitBytes = options.previewLimitBytes ?? DEFAULT_PREVIEW_LIMIT_BYTES;
  const scannedAt = new Date().toISOString();
  const warnings: ScanWarning[] = [];
  const requestedWorkspaceRoots = uniquePaths(workspaceRoots.map((root) => resolveAbsolutePath(root)));
  const normalizedWorkspaceRoots = requestedWorkspaceRoots.filter((root) => {
    const acceptsDirectory = existsSync(root) && statAcceptsDirectory(root);
    if (!acceptsDirectory) {
      warnings.push({
        path: root,
        message: "Scan root is missing or unreadable"
      });
    }
    return acceptsDirectory;
  });
  const scannedResources = await Promise.all(
    [
      ...normalizedWorkspaceRoots.map((root) => ({ root, isGlobal: false })),
      ...GLOBAL_DIRS.map((dir) => ({ root: path.join(homeDir, dir), isGlobal: true }))
    ].map(async (target) => {
      if (!existsSync(target.root) || !statAcceptsDirectory(target.root)) {
        if (!target.isGlobal) {
          warnings.push({
            path: target.root,
            message: "Scan root is missing or unreadable"
          });
        }
        return [] as ScannedResource[];
      }

      const entries = await fg(target.isGlobal ? GLOBAL_ALLOWLIST_PATTERNS : ALLOWLIST_PATTERNS, {
        cwd: target.root,
        absolute: true,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        stats: true,
        ignore: EXCLUDED_DIRS.map((dir) => `**/${dir}/**`)
      });

      const resources: ScannedResource[] = [];
      for (const entry of entries) {
        const stat = entry.stats ?? statSync(entry.path);
        resources.push(await buildResource(entry.path, stat.size, stat.mtimeMs, target.isGlobal, normalizedWorkspaceRoots, homeDir, previewLimitBytes));
      }

      return resources;
    })
  );

  const resources = dedupeScannedResources(scannedResources.flat()).sort((left, right) => left.path.localeCompare(right.path));
  const projects = buildProjects(resources);
  const relationships = buildRelationships(resources);
  const duplicateIds = new Set(
    relationships
      .filter((relationship) => relationship.type === "duplicate_candidate")
      .map((relationship) => relationship.fromResourceId)
  );
  for (const resource of resources) {
    if (duplicateIds.has(resource.id)) {
      resource.status = "duplicate_candidate";
    }
  }
  const projectResourceCounts = new Map<string, Record<string, number>>();
  const projectStatusCounts = new Map<string, Record<string, number>>();

  for (const resource of resources) {
    if (!resource.projectId) {
      continue;
    }

    const resourceCounts = projectResourceCounts.get(resource.projectId) ?? {};
    resourceCounts[resource.kind] = (resourceCounts[resource.kind] ?? 0) + 1;
    projectResourceCounts.set(resource.projectId, resourceCounts);

    const statusCounts = projectStatusCounts.get(resource.projectId) ?? {};
    statusCounts[resource.status] = (statusCounts[resource.status] ?? 0) + 1;
    projectStatusCounts.set(resource.projectId, statusCounts);
  }

  for (const project of projects) {
    project.resourceCounts = projectResourceCounts.get(project.id) ?? {};
    project.statusCounts = projectStatusCounts.get(project.id) ?? {};
  }
  const configurationLoad = await buildConfigurationLoad(resources, relationships, projects, homeDir);

  const result: ScanResult = {
    workspaceRoots: normalizedWorkspaceRoots,
    projects,
    resources: resources.map(stripScannedResource),
    relationships,
    configurationLoad,
    warnings,
    scannedAt
  };

  lastScanCache = {
    scannedAt,
    resources,
    resourceById: new Map(resources.map((resource) => [resource.id, resource]))
  };

  return result;
}

export async function getResourcePreviewById(id: string): Promise<ResourcePreview | null> {
  const cache = lastScanCache;
  if (!cache) {
    return null;
  }

  const resource = cache.resourceById.get(id);
  if (!resource) {
    return null;
  }

  try {
    const preview = await readPreview(resource.path, resource.previewLimitBytes);
    return {
      id: resource.id,
      path: resource.path,
      content: preview.content,
      truncated: preview.truncated
    };
  } catch {
    return null;
  }
}

export function getLastScanCache(): ScanCache | null {
  return lastScanCache;
}

async function buildResource(
  filePath: string,
  size: number,
  mtimeMs: number,
  isGlobal: boolean,
  workspaceRoots: string[],
  homeDir: string,
  previewLimitBytes: number
): Promise<ScannedResource> {
  const normalizedPath = resolveAbsolutePath(filePath);
  const ecosystem = detectEcosystem(normalizedPath, homeDir);
  const projectLocation = isGlobal ? null : detectProjectLocation(normalizedPath, workspaceRoots);
  const projectRoot = projectLocation?.projectRoot;
  const workspaceRoot = projectLocation?.workspaceRoot;
  const repositoryKey = detectRepositoryKey(projectRoot);
  const scopeRoot = detectScopeRoot(normalizedPath, projectRoot);
  const scope = determineScope(normalizedPath, projectRoot, scopeRoot, isGlobal);
  const kind = classifyKind(normalizedPath);
  const name = detectResourceName(normalizedPath, kind);
  const signature = buildSignature(normalizedPath, scopeRoot);
  const relativePathFromProject = projectRoot ? toPosix(path.relative(projectRoot, normalizedPath)).toLowerCase() : undefined;
  const contentIdentity = await readContentIdentity(normalizedPath, size, previewLimitBytes);
  const effectiveResourceKey = buildEffectiveResourceKey(ecosystem, kind, repositoryKey, relativePathFromProject, contentIdentity);
  const status: ResourceStatus = size > previewLimitBytes ? "skipped_large" : "ok";
  const projectId = projectRoot ? sha1(projectRoot) : undefined;
  const scopeConfidence = detectScopeConfidence(ecosystem, kind, projectRoot, scopeRoot, isGlobal);
  const summary = buildSummary(kind, normalizedPath, scopeRoot, scope);
  const tags = buildTags(ecosystem, kind, scope, normalizedPath);

  return {
    id: sha1(`${ecosystem}:${normalizedPath}`),
    name,
    ecosystem,
    kind,
    scope,
    scopePath: scopeRoot,
    scopeConfidence,
    path: normalizedPath,
    projectId,
    effectiveResourceKey,
    mtime: new Date(mtimeMs).toISOString(),
    size,
    summary,
    tags,
    status,
    signature,
    contentIdentity,
    relativePathFromProject,
    projectRoot,
    workspaceRoot,
    repositoryKey,
    detectedBy: projectLocation?.detectedBy,
    previewLimitBytes
  };
}

function detectEcosystem(filePath: string, homeDir: string): Ecosystem {
  const normalized = toPosix(filePath.toLowerCase());
  const globalClaudeRoot = toPosix(path.join(homeDir, ".claude")).toLowerCase();
  const globalCodexRoot = toPosix(path.join(homeDir, ".codex")).toLowerCase();

  if (normalized.includes(`${globalClaudeRoot}/`) || normalized.includes("/.claude/") || path.basename(filePath).toLowerCase() === "claude.md" || path.basename(filePath).toLowerCase() === ".claude.md") {
    return "claude";
  }

  if (
    normalized.includes(`${globalCodexRoot}/`) ||
    normalized.includes("/.codex/") ||
    normalized.includes("/.agents/") ||
    normalized.includes("/.omx/")
  ) {
    return "codex";
  }

  return "codex";
}

function detectProjectLocation(filePath: string, workspaceRoots: string[]): ProjectLocation | null {
  const matchingWorkspaceRoots = workspaceRoots.filter((workspaceRoot) => isInside(filePath, workspaceRoot));
  if (matchingWorkspaceRoots.length === 0) {
    return null;
  }

  const workspaceRoot = matchingWorkspaceRoots.sort((left, right) => right.length - left.length)[0];
  const gitRoot = findNearestGitRoot(filePath, workspaceRoot);
  if (gitRoot) {
    return {
      projectRoot: gitRoot,
      workspaceRoot,
      detectedBy: "git"
    };
  }

  const relative = path.relative(workspaceRoot, filePath);
  const firstSegment = relative.split(path.sep)[0];
  if (firstSegment && firstSegment !== "." && firstSegment !== "..") {
    const child = path.join(workspaceRoot, firstSegment);
    if (existsSync(child) && statSync(child).isDirectory()) {
      return {
        projectRoot: child,
        workspaceRoot,
        detectedBy: "workspace_child"
      };
    }
  }

  return {
    projectRoot: workspaceRoot,
    workspaceRoot,
    detectedBy: "workspace_child"
  };
}

function findNearestGitRoot(filePath: string, ceiling: string): string | null {
  let current = path.dirname(filePath);
  const ceilingResolved = resolveAbsolutePath(ceiling);

  while (isInside(current, ceilingResolved) || current === ceilingResolved) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }

    if (current === ceilingResolved) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function detectScopeRoot(filePath: string, projectRoot?: string): string {
  let current = path.dirname(filePath);
  while (current !== path.dirname(current)) {
    const scopeName = path.basename(current).toLowerCase();
    if (scopeName === ".codex" || scopeName === ".claude" || scopeName === ".omx") {
      return current;
    }

    if (projectRoot && !isInside(current, projectRoot) && current !== projectRoot) {
      break;
    }

    if (projectRoot && current === projectRoot) {
      break;
    }

    current = path.dirname(current);
  }

  return path.dirname(filePath);
}

function determineScope(filePath: string, projectRoot: string | undefined, scopeRoot: string, isGlobal: boolean): ResourceScope {
  if (isGlobal) {
    return "global";
  }

  if (!projectRoot) {
    return "nested";
  }

  if (scopeRoot === projectRoot || path.dirname(scopeRoot) === projectRoot) {
    return "project";
  }

  return "nested";
}

function buildProjects(resources: ScannedResource[]): Project[] {
  const projectMap = new Map<string, Project>();
  const locationByProject = new Map<string, { projectRoot: string; workspaceRoot: string; detectedBy: Project["detectedBy"] }>();

  for (const resource of resources) {
    if (!resource.projectId || !resource.projectRoot || !resource.workspaceRoot || !resource.detectedBy) {
      continue;
    }

    if (!locationByProject.has(resource.projectId)) {
      locationByProject.set(resource.projectId, {
        projectRoot: resource.projectRoot,
        workspaceRoot: resource.workspaceRoot,
        detectedBy: resource.detectedBy
      });
    }
  }

  for (const [projectId, location] of locationByProject.entries()) {
    projectMap.set(projectId, {
      id: projectId,
      name: path.basename(location.projectRoot),
      rootPath: location.projectRoot,
      workspaceRoot: location.workspaceRoot,
      detectedBy: location.detectedBy,
      resourceCounts: {},
      statusCounts: {}
    });
  }

  return [...projectMap.values()].sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}

function buildRelationships(resources: ScannedResource[]): Relationship[] {
  const relationships: Relationship[] = [];
  const bySignature = groupBy(
    resources,
    (resource) => `${resource.ecosystem}:${resource.kind}:${relationshipDomainKey(resource)}:${resource.signature}`
  );

  for (const group of bySignature.values()) {
    if (group.length < 2) {
      continue;
    }

    const ordered = [...group].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.path.localeCompare(right.path));

    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      for (let shadowedIndex = 0; shadowedIndex < index; shadowedIndex += 1) {
        const shadowed = ordered[shadowedIndex];
        if (scopeRank(current.scope) === scopeRank(shadowed.scope)) {
          continue;
        }

        relationships.push({
          type: "shadows",
          fromResourceId: current.id,
          toResourceId: shadowed.id,
          projectId: current.projectId ?? shadowed.projectId,
          reason: `${current.scope} resource overrides matching ${shadowed.scope} resource`
        });
        relationships.push({
          type: "shadowed_by",
          fromResourceId: shadowed.id,
          toResourceId: current.id,
          projectId: current.projectId ?? shadowed.projectId,
          reason: `${shadowed.scope} resource is overridden by ${current.scope} resource`
        });
      }
    }

    const rankGroups = groupBy(group, (resource) => scopeRank(resource.scope));
    for (const sameRankGroup of rankGroups.values()) {
      const duplicateGroups = groupBy(sameRankGroup, duplicateIdentityKey);
      for (const duplicateGroup of duplicateGroups.values()) {
        if (duplicateGroup.length < 2) {
          continue;
        }

        const [canonical, ...duplicates] = [...duplicateGroup].sort((left, right) => left.path.localeCompare(right.path));
        for (const duplicate of duplicates) {
          relationships.push({
            type: "duplicate_candidate",
            fromResourceId: duplicate.id,
            toResourceId: canonical.id,
            projectId: duplicate.projectId ?? canonical.projectId,
            reason: "Allowlisted resource with the same signature and content appears in multiple roots"
          });
        }
      }
    }
  }

  const globalsByKind = groupBy(
    resources.filter((resource) => resource.scope === "global"),
    (resource) => `${resource.ecosystem}:${resource.kind}`
  );

  for (const resource of resources) {
    if (resource.scope === "global") {
      continue;
    }

    const candidates = globalsByKind.get(`${resource.ecosystem}:${resource.kind}`);
    if (!candidates || candidates.length === 0) {
      continue;
    }

    const preferred = [...candidates].sort((left, right) => {
      const sameBaseLeft = path.basename(left.path).toLowerCase() === path.basename(resource.path).toLowerCase() ? 0 : 1;
      const sameBaseRight = path.basename(right.path).toLowerCase() === path.basename(resource.path).toLowerCase() ? 0 : 1;
      return sameBaseLeft - sameBaseRight || left.path.localeCompare(right.path);
    })[0];

    relationships.push({
      type: "inherited_from_global",
      fromResourceId: resource.id,
      toResourceId: preferred.id,
      projectId: resource.projectId,
      reason: `Uses global ${preferred.kind} resource as the nearest baseline`
    });
  }

  return relationships.sort((left, right) => left.type.localeCompare(right.type) || left.fromResourceId.localeCompare(right.fromResourceId) || (left.toResourceId ?? "").localeCompare(right.toResourceId ?? ""));
}

async function buildConfigurationLoad(
  resources: ScannedResource[],
  relationships: Relationship[],
  projects: Project[],
  homeDir: string
): Promise<ConfigurationLoadAnalysis> {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const baselineIds = new Set(resources.filter((resource) => isCodexDefaultResource(resource.path, homeDir)).map((resource) => resource.id));
  const userResources = dedupeWorktreeEquivalentResources(resources.filter((resource) => !baselineIds.has(resource.id)));
  const userResourceIds = new Set(userResources.map((resource) => resource.id));
  const promptResources = userResources.filter((resource) => PROMPT_LOAD_KINDS.has(resource.kind));
  const toolResources = userResources.filter((resource) => TOOL_LOAD_KINDS.has(resource.kind));
  const mcpServers = await extractMcpServers(userResources);
  const conflictRelationships = relationships.filter(
    (relationship) =>
      (userResourceIds.has(relationship.fromResourceId) || Boolean(relationship.toResourceId && userResourceIds.has(relationship.toResourceId))) &&
      CONFLICT_RELATIONSHIP_TYPES.has(relationship.type)
  );
  const nestedResources = userResources.filter((resource) => resource.scope === "nested").length;
  const projectsWithLocalResources = new Set(
    userResources
      .filter((resource) => resource.projectId && resource.scope !== "global")
      .map((resource) => resource.projectId as string)
  ).size;
  const estimatedTokens = Math.ceil(sumBy(promptResources, (resource) => resource.size) / 4);
  const toolSurfaceUnits = toolResources.length + mcpServers.length;
  const promptScore = clampScore((estimatedTokens / 20000) * 100);
  const toolScore = clampScore((toolSurfaceUnits / 50) * 100);
  const conflictScore = clampScore((conflictRelationships.length / 20) * 100);
  const scopeScore = clampScore(((nestedResources + projectsWithLocalResources * 2) / 40) * 100);
  const score = clampScore(promptScore * 0.35 + toolScore * 0.3 + conflictScore * 0.2 + scopeScore * 0.15);

  return {
    baseline: "codex_default_install",
    score,
    level: loadLevel(score),
    excludedDefaultResources: baselineIds.size,
    categories: [
      {
        key: "prompt_footprint",
        label: "Prompt Footprint",
        score: promptScore,
        value: estimatedTokens,
        detail: `${promptResources.length.toLocaleString()} instruction/config resources, ~${estimatedTokens.toLocaleString()} estimated tokens`
      },
      {
        key: "tool_surface",
        label: "Tool Surface",
        score: toolScore,
        value: toolSurfaceUnits,
        detail: `${toolResources.length.toLocaleString()} tool resources plus ${mcpServers.length.toLocaleString()} MCP servers`
      },
      {
        key: "conflict_risk",
        label: "Conflict Risk",
        score: conflictScore,
        value: conflictRelationships.length,
        detail: `${conflictRelationships.length.toLocaleString()} duplicate or shadowing relationships`
      },
      {
        key: "scope_complexity",
        label: "Scope Complexity",
        score: scopeScore,
        value: nestedResources + projectsWithLocalResources * 2,
        detail: `${nestedResources.toLocaleString()} nested resources across ${projectsWithLocalResources.toLocaleString()} projects with local resources`
      }
    ] satisfies LoadCategory[],
    topContributors: buildLoadContributors(promptResources, toolResources, conflictRelationships, mcpServers, projectById).slice(0, 5),
    projectSummaries: buildProjectLoadSummaries(userResources, projects).slice(0, 5),
    mcpServers: buildMcpServerContributors(mcpServers, projectById)
  };
}

function buildLoadContributors(
  promptResources: ScannedResource[],
  toolResources: ScannedResource[],
  conflictRelationships: Relationship[],
  mcpServers: Array<{ name: string; resource: ScannedResource }>,
  projectById: Map<string, Project>
): LoadContributor[] {
  const contributors: LoadContributor[] = [];

  for (const resource of promptResources) {
    const estimatedTokens = Math.ceil(resource.size / 4);
    contributors.push({
      label: displayResourceLabel(resource),
      kind: resource.kind,
      resourceId: resource.id,
      projectId: resource.projectId,
      projectName: resource.projectId ? projectById.get(resource.projectId)?.name : undefined,
      score: estimatedTokens,
      reason: `Prompt/config footprint: ~${estimatedTokens.toLocaleString()} estimated tokens`
    });
  }

  for (const resource of toolResources) {
    contributors.push({
      label: displayResourceLabel(resource),
      kind: resource.kind,
      resourceId: resource.id,
      projectId: resource.projectId,
      projectName: resource.projectId ? projectById.get(resource.projectId)?.name : undefined,
      score: 1,
      reason: `Adds one ${resource.kind} resource to the available tool surface`
    });
  }

  for (const server of mcpServers) {
    contributors.push({
      label: server.name,
      kind: "mcp_server",
      resourceId: server.resource.id,
      projectId: server.resource.projectId,
      projectName: server.resource.projectId ? projectById.get(server.resource.projectId)?.name : undefined,
      score: 1,
      reason: `MCP server declared in ${displayResourceLabel(server.resource)}`
    });
  }

  const duplicateCount = conflictRelationships.filter((relationship) => relationship.type === "duplicate_candidate").length;
  if (duplicateCount > 0) {
    contributors.push({
      label: "Duplicate candidates",
      kind: "other",
      score: duplicateCount,
      reason: `${duplicateCount.toLocaleString()} exact duplicate resources found across scanned roots or worktrees`
    });
  }

  const conflictCounts = countBy(
    conflictRelationships.filter((relationship) => relationship.type !== "duplicate_candidate"),
    (relationship) => relationship.fromResourceId
  );
  for (const [resourceId, count] of Object.entries(conflictCounts)) {
    const resource = [...promptResources, ...toolResources].find((candidate) => candidate.id === resourceId);
    contributors.push({
      label: resource ? displayResourceLabel(resource) : resourceId.slice(0, 8),
      kind: resource?.kind ?? "other",
      resourceId,
      projectId: resource?.projectId,
      projectName: resource?.projectId ? projectById.get(resource.projectId)?.name : undefined,
      score: count,
      reason: `${count.toLocaleString()} duplicate or shadowing relationships`
    });
  }

  return contributors.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

function buildMcpServerContributors(
  mcpServers: Array<{ name: string; resource: ScannedResource }>,
  projectById: Map<string, Project>
): LoadContributor[] {
  return mcpServers.map((server) => ({
    label: server.name,
    kind: "mcp_server",
    resourceId: server.resource.id,
    projectId: server.resource.projectId,
    projectName: server.resource.projectId ? projectById.get(server.resource.projectId)?.name : undefined,
    score: 1,
    reason: `MCP server declared in ${displayResourceLabel(server.resource)}`
  }));
}

function buildProjectLoadSummaries(resources: ScannedResource[], projects: Project[]): ProjectLoadSummary[] {
  return projects
    .map((project) => {
      const projectResources = resources.filter((resource) => resource.projectId === project.id);
      const estimatedTokens = Math.ceil(sumBy(projectResources.filter((resource) => PROMPT_LOAD_KINDS.has(resource.kind)), (resource) => resource.size) / 4);
      const toolUnits = projectResources.filter((resource) => TOOL_LOAD_KINDS.has(resource.kind)).length;
      const nestedUnits = projectResources.filter((resource) => resource.scope === "nested").length;
      const score = clampScore((estimatedTokens / 5000) * 45 + (toolUnits / 15) * 35 + (nestedUnits / 10) * 20);
      return {
        projectId: project.id,
        projectName: project.name,
        score,
        resourceCount: projectResources.length
      };
    })
    .filter((summary) => summary.resourceCount > 0)
    .sort((left, right) => right.score - left.score || left.projectName.localeCompare(right.projectName));
}

async function extractMcpServers(resources: ScannedResource[]): Promise<Array<{ name: string; resource: ScannedResource }>> {
  const configs = resources.filter((resource) => path.basename(resource.path).toLowerCase() === "config.toml" && toPosix(resource.path.toLowerCase()).includes("/.codex/"));
  const servers: Array<{ name: string; resource: ScannedResource }> = [];

  for (const resource of configs) {
    if (resource.status === "skipped_large" || isSymlink(resource.path)) {
      continue;
    }

    try {
      const preview = await readPreview(resource.path, resource.previewLimitBytes);
      for (const name of extractMcpServerNames(preview.content)) {
        servers.push({ name, resource });
      }
    } catch {
      // Keep scan read-only and best-effort; unreadable configs simply add no MCP servers.
    }
  }

  return servers;
}

function extractMcpServerNames(content: string): string[] {
  const names = new Set<string>();
  const sectionPattern = /^\s*\[\s*(?:mcp_servers|mcpServers)\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*]\s*(?:#.*)?$/;

  for (const line of content.split(/\r?\n/)) {
    const match = sectionPattern.exec(line);
    if (match) {
      names.add(match[1] ?? match[2]);
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function isCodexDefaultResource(resourcePath: string, homeDir: string): boolean {
  const normalizedPath = toPosix(resolveAbsolutePath(resourcePath));
  const codexRoot = toPosix(path.join(resolveAbsolutePath(homeDir), ".codex"));
  const defaultPrefixes = [
    `${codexRoot}/skills/.system/`,
    `${codexRoot}/plugins/cache/openai-bundled/`,
    `${codexRoot}/plugins/cache/openai-primary-runtime/`
  ];

  return defaultPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function loadLevel(score: number): LoadLevel {
  if (score >= 75) {
    return "severe";
  }
  if (score >= 50) {
    return "high";
  }
  if (score >= 25) {
    return "moderate";
  }
  return "low";
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function displayResourceLabel(resource: AgentResource): string {
  return `${resource.name} (${resource.kind})`;
}

function sumBy<T>(items: T[], getValue: (item: T) => number): number {
  return items.reduce((sum, item) => sum + getValue(item), 0);
}

function dedupeScannedResources(resources: ScannedResource[]): ScannedResource[] {
  return [...new Map(resources.map((resource) => [resource.id, resource])).values()];
}

function dedupeWorktreeEquivalentResources(resources: ScannedResource[]): ScannedResource[] {
  const byEffectiveSource = new Map<string, ScannedResource>();
  for (const resource of resources) {
    const key = resource.effectiveResourceKey ?? resource.id;
    const current = byEffectiveSource.get(key);
    if (!current || resource.path.localeCompare(current.path) < 0) {
      byEffectiveSource.set(key, resource);
    }
  }

  return [...byEffectiveSource.values()];
}

function buildEffectiveResourceKey(
  ecosystem: Ecosystem,
  kind: ResourceKind,
  repositoryKey: string | undefined,
  relativePathFromProject: string | undefined,
  contentIdentity: string | undefined
): string | undefined {
  if (!repositoryKey || !relativePathFromProject || !contentIdentity) {
    return undefined;
  }

  return sha1(`${ecosystem}:${kind}:${repositoryKey}:${relativePathFromProject}:${contentIdentity}`);
}

function duplicateIdentityKey(resource: ScannedResource): string {
  return resource.contentIdentity
    ? `${worktreeRelativeResourceKey(resource)}:content:${resource.contentIdentity}`
    : `resource:${resource.id}`;
}

function worktreeRelativeResourceKey(resource: ScannedResource): string {
  return resource.relativePathFromProject ?? `${resource.scope}:${resource.signature}`;
}

async function readContentIdentity(filePath: string, size: number, previewLimitBytes: number): Promise<string | undefined> {
  if (size > previewLimitBytes || isSymlink(filePath)) {
    return undefined;
  }

  try {
    const content = await fs.readFile(filePath);
    if (content.includes(0)) {
      return undefined;
    }
    return `${size}:${sha1(content)}`;
  } catch {
    return undefined;
  }
}

async function readPreview(filePath: string, previewLimitBytes: number): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Not a file");
  }

  if (isSymlink(filePath)) {
    throw new Error("Symlink preview disabled");
  }

  const bytesToRead = Math.min(previewLimitBytes, stat.size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new Error("Binary preview disabled");
    }

    return {
      content: new TextDecoder("utf-8", { fatal: false }).decode(slice),
      truncated: stat.size > previewLimitBytes
    };
  } finally {
    await handle.close();
  }
}

function classifyKind(filePath: string): ResourceKind {
  const normalized = toPosix(filePath.toLowerCase());
  const base = path.basename(normalized);

  if (base === "agents.md") {
    return "agents_md";
  }
  if (base === "claude.md" || base === ".claude.md") {
    return "claude_md";
  }
  if (normalized.includes("/plugins/")) {
    return "plugin";
  }
  if (base === "skill.md" && normalized.includes("/skills/")) {
    return "skill";
  }
  if (normalized.includes("/commands/")) {
    return "command";
  }
  if (normalized.includes("/subagents/") || normalized.includes("/agents/")) {
    return "subagent";
  }
  if (base === "config.toml") {
    return "setting";
  }
  if (base.startsWith("settings.")) {
    return "setting";
  }
  if (base.startsWith("mcp")) {
    return "mcp";
  }
  if (normalized.includes("/automation/") || normalized.includes("/automations/")) {
    return "automation";
  }
  if (normalized.includes("/.omx/")) {
    return "omx";
  }

  return "other";
}

function detectResourceName(filePath: string, kind: ResourceKind): string {
  const base = path.basename(filePath);
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  const parent = path.basename(path.dirname(filePath));

  switch (kind) {
    case "skill":
      return base.toLowerCase() === "skill.md" ? parent : stem;
    case "command":
    case "subagent":
    case "plugin":
    case "automation":
    case "mcp":
    case "setting":
    case "omx":
      return stem;
    case "agents_md":
      return "AGENTS.md";
    case "claude_md":
      return "CLAUDE.md";
    default:
      return stem || base;
  }
}

function buildSignature(filePath: string, scopeRoot: string): string {
  const relative = path.relative(scopeRoot, filePath) || path.basename(filePath);
  return toPosix(relative).toLowerCase();
}

function buildSummary(kind: ResourceKind, filePath: string, scopeRoot: string, scope: ResourceScope): string {
  const relative = path.relative(scopeRoot, filePath) || path.basename(filePath);
  switch (kind) {
    case "agents_md":
      return `Agent instructions for ${scope} scope`;
    case "claude_md":
      return `Claude instructions for ${scope} scope`;
    case "skill":
      return `Skill definition at ${relative}`;
    case "command":
      return `Command definition at ${relative}`;
    case "subagent":
      return `Subagent definition at ${relative}`;
    case "setting":
      return `Settings file at ${relative}`;
    case "mcp":
      return `MCP configuration at ${relative}`;
    case "plugin":
      return `Plugin resource at ${relative}`;
    case "automation":
      return `Automation resource at ${relative}`;
    case "omx":
      return `OMX resource at ${relative}`;
    default:
      return `Allowlisted resource at ${relative}`;
  }
}

function buildTags(ecosystem: Ecosystem, kind: ResourceKind, scope: ResourceScope, filePath: string): string[] {
  const tags = new Set<string>([ecosystem, kind, scope]);
  const directoryParts = toPosix(path.dirname(filePath))
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("."));

  for (const segment of directoryParts.slice(-3)) {
    tags.add(segment);
  }

  return [...tags];
}

function stripScannedResource(resource: ScannedResource): AgentResource {
  const {
    signature: _signature,
    contentIdentity: _contentIdentity,
    relativePathFromProject: _relativePathFromProject,
    projectRoot: _projectRoot,
    workspaceRoot: _workspaceRoot,
    repositoryKey: _repositoryKey,
    detectedBy: _detectedBy,
    previewLimitBytes: _previewLimitBytes,
    ...rest
  } = resource;
  return rest;
}

function detectRepositoryKey(projectRoot?: string): string | undefined {
  if (!projectRoot) {
    return undefined;
  }

  const gitPath = path.join(projectRoot, ".git");
  if (!existsSync(gitPath)) {
    return undefined;
  }

  try {
    if (lstatSync(gitPath).isDirectory()) {
      return resolveAbsolutePath(gitPath);
    }

    const gitDirLine = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!gitDirLine) {
      return undefined;
    }

    const gitDir = path.isAbsolute(gitDirLine)
      ? path.normalize(gitDirLine)
      : path.resolve(projectRoot, gitDirLine);
    return path.basename(path.dirname(gitDir)) === "worktrees"
      ? path.dirname(path.dirname(gitDir))
      : gitDir;
  } catch {
    return undefined;
  }
}

function relationshipDomainKey(resource: ScannedResource): string {
  if (resource.scope === "global") {
    return "global";
  }

  if (resource.repositoryKey) {
    return `repo:${resource.repositoryKey}`;
  }

  return resource.projectId ? `project:${resource.projectId}` : `scope:${resource.scopePath}`;
}

function detectScopeConfidence(
  ecosystem: Ecosystem,
  kind: ResourceKind,
  projectRoot: string | undefined,
  scopeRoot: string,
  isGlobal: boolean
): ScopeConfidence {
  if (isGlobal) {
    return "exact";
  }

  if (ecosystem === "claude") {
    return "inferred";
  }

  if (!projectRoot) {
    return "inferred";
  }

  return kind === "agents_md" || scopeRoot === projectRoot || path.dirname(scopeRoot) === projectRoot
    ? "exact"
    : "inferred";
}

function statAcceptsDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function resolveAbsolutePath(target: string): string {
  return path.resolve(target);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((candidate) => resolveAbsolutePath(candidate)))];
}

function toPosix(target: string): string {
  return target.split(path.sep).join("/");
}

function sha1(value: string | Buffer): string {
  return createHash("sha1").update(value).digest("hex");
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function scopeRank(scope: ResourceScope): number {
  switch (scope) {
    case "global":
      return 0;
    case "project":
      return 1;
    case "nested":
      return 2;
  }
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function groupBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}
