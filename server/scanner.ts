import fg from "fast-glob";
import { createHash } from "crypto";
import { existsSync, lstatSync, statSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { getCommonWorkspaceRoots, getDefaultWorkspaceRoot } from "./config";
import type {
  AgentResource,
  DefaultsResponse,
  Ecosystem,
  Project,
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
  projectRoot?: string;
  workspaceRoot?: string;
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
        resources.push(buildResource(entry.path, stat.size, stat.mtimeMs, target.isGlobal, normalizedWorkspaceRoots, homeDir, previewLimitBytes));
      }

      return resources;
    })
  );

  const resources = scannedResources.flat().sort((left, right) => left.path.localeCompare(right.path));
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

  const result: ScanResult = {
    workspaceRoots: normalizedWorkspaceRoots,
    projects,
    resources: resources.map(stripScannedResource),
    relationships,
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

function buildResource(
  filePath: string,
  size: number,
  mtimeMs: number,
  isGlobal: boolean,
  workspaceRoots: string[],
  homeDir: string,
  previewLimitBytes: number
): ScannedResource {
  const normalizedPath = resolveAbsolutePath(filePath);
  const ecosystem = detectEcosystem(normalizedPath, homeDir);
  const projectLocation = isGlobal ? null : detectProjectLocation(normalizedPath, workspaceRoots);
  const projectRoot = projectLocation?.projectRoot;
  const workspaceRoot = projectLocation?.workspaceRoot;
  const scopeRoot = detectScopeRoot(normalizedPath, projectRoot);
  const scope = determineScope(normalizedPath, projectRoot, scopeRoot, isGlobal);
  const kind = classifyKind(normalizedPath);
  const name = detectResourceName(normalizedPath, kind);
  const signature = buildSignature(normalizedPath, scopeRoot);
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
    mtime: new Date(mtimeMs).toISOString(),
    size,
    summary,
    tags,
    status,
    signature,
    projectRoot,
    workspaceRoot,
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
  const bySignature = groupBy(resources, (resource) => `${resource.ecosystem}:${resource.kind}:${resource.signature}`);

  for (const group of bySignature.values()) {
    if (group.length < 2) {
      continue;
    }

    const ordered = [...group].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.path.localeCompare(right.path));

    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      for (let shadowedIndex = 0; shadowedIndex < index; shadowedIndex += 1) {
        const shadowed = ordered[shadowedIndex];
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
      if (sameRankGroup.length < 2) {
        continue;
      }

      const [canonical, ...duplicates] = [...sameRankGroup].sort((left, right) => left.path.localeCompare(right.path));
      for (const duplicate of duplicates) {
        relationships.push({
          type: "duplicate_candidate",
          fromResourceId: duplicate.id,
          toResourceId: canonical.id,
          projectId: duplicate.projectId ?? canonical.projectId,
          reason: "Allowlisted resource with the same signature appears in multiple roots"
        });
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
    projectRoot: _projectRoot,
    workspaceRoot: _workspaceRoot,
    detectedBy: _detectedBy,
    previewLimitBytes: _previewLimitBytes,
    ...rest
  } = resource;
  return rest;
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

function sha1(value: string): string {
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
