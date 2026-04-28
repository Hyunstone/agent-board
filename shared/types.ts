export type Ecosystem = "codex" | "claude";

export type ResourceKind =
  | "agents_md"
  | "claude_md"
  | "skill"
  | "command"
  | "subagent"
  | "setting"
  | "mcp"
  | "plugin"
  | "automation"
  | "omx"
  | "other";

export type ResourceScope = "global" | "project" | "nested";
export type ScopeConfidence = "exact" | "inferred";
export type ResourceStatus = "ok" | "duplicate_candidate" | "unreadable" | "skipped_large";

export type RelationshipType =
  | "shadows"
  | "shadowed_by"
  | "duplicate_candidate"
  | "inherited_from_global";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  detectedBy: "git" | "workspace_child" | "global";
  resourceCounts: Record<string, number>;
  statusCounts: Record<string, number>;
}

export interface AgentResource {
  id: string;
  name: string;
  ecosystem: Ecosystem;
  kind: ResourceKind;
  scope: ResourceScope;
  scopePath: string;
  scopeConfidence: ScopeConfidence;
  path: string;
  projectId?: string;
  effectiveResourceKey?: string;
  mtime: string;
  size: number;
  summary: string;
  tags: string[];
  status: ResourceStatus;
}

export interface Relationship {
  type: RelationshipType;
  fromResourceId: string;
  toResourceId?: string;
  projectId?: string;
  reason: string;
}

export type LoadLevel = "low" | "moderate" | "high" | "severe";
export type LoadCategoryKey = "prompt_footprint" | "tool_surface" | "conflict_risk" | "scope_complexity";

export interface LoadCategory {
  key: LoadCategoryKey;
  label: string;
  score: number;
  value: number;
  detail: string;
}

export interface LoadContributor {
  label: string;
  kind: ResourceKind | "mcp_server";
  score: number;
  reason: string;
  resourceId?: string;
  projectId?: string;
  projectName?: string;
}

export interface ProjectLoadSummary {
  projectId: string;
  projectName: string;
  score: number;
  resourceCount: number;
}

export interface ConfigurationLoadAnalysis {
  baseline: "codex_default_install";
  score: number;
  level: LoadLevel;
  excludedDefaultResources: number;
  categories: LoadCategory[];
  topContributors: LoadContributor[];
  projectSummaries: ProjectLoadSummary[];
  mcpServers: LoadContributor[];
  measured?: {
    runs: number;
    medianLatencyMs?: number;
    medianInputTokens?: number;
    medianToolCalls?: number;
  };
}

export interface ScanWarning {
  path: string;
  message: string;
}

export interface ScanResult {
  workspaceRoots: string[];
  projects: Project[];
  resources: AgentResource[];
  relationships: Relationship[];
  configurationLoad: ConfigurationLoadAnalysis;
  warnings: ScanWarning[];
  scannedAt: string;
}

export interface DefaultsResponse {
  defaultWorkspaceRoot: string;
  commonPaths: string[];
  globals: {
    codex: { path: string; exists: boolean };
    claude: { path: string; exists: boolean };
    agents: { path: string; exists: boolean };
  };
}

export interface ScanRequest {
  workspaceRoots: string[];
}

export interface ResourcePreview {
  id: string;
  path: string;
  content: string;
  truncated: boolean;
}
