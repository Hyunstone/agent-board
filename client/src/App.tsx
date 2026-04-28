import { useEffect, useMemo, useState } from "react";
import { fetchDefaults, fetchResourcePreview, scanWorkspaces } from "./api";
import type {
  AgentResource,
  ConfigurationLoadAnalysis,
  DefaultsResponse,
  Project,
  Relationship,
  ResourcePreview,
  ScanResult
} from "../../shared/types";

const storageKey = "agent-board.workspace-roots";
const allOption = "all";

type Filters = {
  ecosystem: string;
  kind: string;
  scope: string;
  status: string;
  project: string;
  query: string;
};

type SkillCoverage = {
  name: string;
  ecosystems: string[];
  resources: AgentResource[];
  globalResources: AgentResource[];
  projectResources: AgentResource[];
  projectIds: string[];
};

type ProjectContext = {
  project: Project | null;
  skills: AgentResource[];
  projectSkills: AgentResource[];
  globalSkills: AgentResource[];
  agents: AgentResource[];
  projectAgents: AgentResource[];
  globalAgents: AgentResource[];
  instructions: AgentResource[];
};

type ActiveContextImpact = {
  projectName: string;
  score: number;
  level: "low" | "moderate" | "high";
  confidence: "exact" | "inferred";
  evidenceLevel: "file-backed" | "mixed-estimate";
  instructionTokens: number;
  ruleFiles: AgentResource[];
  globalRuleInventory: AgentResource[];
  conditionalRuleFiles: AgentResource[];
  localSkillCandidates: AgentResource[];
  globalSkillCandidates: AgentResource[];
  localToolCandidates: AgentResource[];
  globalToolCandidates: AgentResource[];
  mcpServers: ConfigurationLoadAnalysis["mcpServers"];
  alwaysLoaded: AgentResource[];
  caveats: string[];
};

const initialFilters: Filters = {
  ecosystem: allOption,
  kind: allOption,
  scope: allOption,
  status: allOption,
  project: allOption,
  query: ""
};

export function App() {
  const [defaults, setDefaults] = useState<DefaultsResponse | null>(null);
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDefaults()
      .then((response) => {
        setDefaults(response);
        const saved = readSavedRoots();
        const roots = saved.length > 0 ? saved : [response.defaultWorkspaceRoot];
        setWorkspaceRoots(roots);
        return scanWorkspaces(roots);
      })
      .then(setScanResult)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(workspaceRoots));
  }, [workspaceRoots]);

  const projectById = useMemo(() => {
    return new Map((scanResult?.projects ?? []).map((project) => [project.id, project]));
  }, [scanResult]);

  const selectedResource = useMemo(() => {
    return scanResult?.resources.find((resource) => resource.id === selectedResourceId) ?? null;
  }, [scanResult, selectedResourceId]);

  const selectedProject = useMemo(() => {
    return scanResult?.projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [scanResult, selectedProjectId]);

  const relationshipsByResource = useMemo(() => {
    const map = new Map<string, Relationship[]>();
    for (const relationship of scanResult?.relationships ?? []) {
      const list = map.get(relationship.fromResourceId) ?? [];
      list.push(relationship);
      map.set(relationship.fromResourceId, list);
    }
    return map;
  }, [scanResult]);

  const filteredResources = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return (scanResult?.resources ?? []).filter((resource) => {
      if (filters.ecosystem !== allOption && resource.ecosystem !== filters.ecosystem) return false;
      if (filters.kind !== allOption && resource.kind !== filters.kind) return false;
      if (filters.scope !== allOption && resource.scope !== filters.scope) return false;
      if (filters.status !== allOption && resource.status !== filters.status) return false;
      if (filters.project !== allOption && resource.projectId !== filters.project) return false;
      if (!query) return true;

      const projectName = resource.projectId ? projectById.get(resource.projectId)?.name ?? "" : "global";
      return [
        displayName(resource),
        resource.path,
        resource.scopePath,
        resource.kind,
        resource.ecosystem,
        resource.summary,
        projectName
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [filters, projectById, scanResult]);

  const visibleResources = useMemo(() => filteredResources.slice(0, 300), [filteredResources]);

  const overview = useMemo(() => {
    const resources = scanResult?.resources ?? [];
    const relationships = scanResult?.relationships ?? [];
    const projects = scanResult?.projects ?? [];
    const byEcosystem = countBy(resources, (resource) => resource.ecosystem);
    const byScope = countBy(resources, (resource) => resource.scope);
    const byKind = topEntries(countBy(resources, (resource) => resource.kind), 7);
    const attentionResources = resources
      .filter((resource) => resource.status !== "ok")
      .sort(
        (left, right) =>
          statusWeight(right.status) - statusWeight(left.status) ||
          displayName(left).localeCompare(displayName(right))
      )
      .slice(0, 8);
    const relationshipCounts = countBy(relationships, (relationship) => relationship.type);
    const topProjects = projects
      .map((project) => ({
        project,
        count: resources.filter((resource) => resource.projectId === project.id).length
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6);
    const topSkills = resources
      .filter((resource) => resource.kind === "skill")
      .sort((left, right) => displayName(left).localeCompare(displayName(right)))
      .slice(0, 12);

    return {
      byEcosystem,
      byScope,
      byKind,
      attentionResources,
      relationshipCounts,
      topProjects,
      topSkills,
      totals: {
        resources: resources.length,
        projects: projects.length,
        global: resources.filter((resource) => resource.scope === "global").length,
        warnings: scanResult?.warnings.length ?? 0,
        relationships: relationships.length
      }
    };
  }, [scanResult]);

  const skillBoard = useMemo(() => {
    const skillResources = (scanResult?.resources ?? []).filter((resource) => resource.kind === "skill");
    const skillMap = new Map<string, SkillCoverage>();

    for (const resource of skillResources) {
      const name = displayName(resource);
      const key = name.toLowerCase();
      const current =
        skillMap.get(key) ??
        ({
          name,
          ecosystems: [],
          resources: [],
          globalResources: [],
          projectResources: [],
          projectIds: []
        } satisfies SkillCoverage);

      current.resources.push(resource);
      if (!current.ecosystems.includes(resource.ecosystem)) {
        current.ecosystems.push(resource.ecosystem);
      }
      if (resource.scope === "global") {
        current.globalResources.push(resource);
      }
      if (resource.projectId) {
        current.projectResources.push(resource);
        if (!current.projectIds.includes(resource.projectId)) {
          current.projectIds.push(resource.projectId);
        }
      }
      skillMap.set(key, current);
    }

    const rows = [...skillMap.values()].sort(
      (left, right) =>
        Number(right.projectResources.length > 0) - Number(left.projectResources.length > 0) ||
        Number(right.globalResources.length > 0) - Number(left.globalResources.length > 0) ||
        left.name.localeCompare(right.name)
    );
    const query = skillSearch.trim().toLowerCase();
    const filteredRows = query
      ? rows.filter((row) => {
          const projectNames = row.projectIds.map((id) => projectById.get(id)?.name ?? "").join(" ");
          return `${row.name} ${row.ecosystems.join(" ")} ${projectNames}`.toLowerCase().includes(query);
        })
      : rows;

    const projectColumns = [...projectById.values()]
      .map((project) => ({
        project,
        count: skillResources.filter((resource) => resource.projectId === project.id).length
      }))
      .filter((item) => item.count > 0)
      .sort((left, right) => right.count - left.count || left.project.name.localeCompare(right.project.name))
      .slice(0, 7)
      .map((item) => item.project);

    return {
      rows,
      filteredRows,
      projectColumns,
      stats: {
        unique: rows.length,
        global: rows.filter((row) => row.globalResources.length > 0).length,
        projectLocal: rows.filter((row) => row.projectResources.length > 0).length,
        both: rows.filter((row) => row.globalResources.length > 0 && row.projectResources.length > 0).length
      }
    };
  }, [projectById, scanResult, skillSearch]);

  const activeProjectId = selectedProjectId ?? scanResult?.projects[0]?.id ?? null;
  const activeProject = activeProjectId ? projectById.get(activeProjectId) ?? null : null;
  const projectContext = useMemo<ProjectContext>(() => {
    const resources = scanResult?.resources ?? [];
    const scopedToProject = (resource: AgentResource) =>
      resource.scope === "global" || (activeProjectId ? resource.projectId === activeProjectId : false);
    const dedupeByName = (items: AgentResource[]) => {
      const byName = new Map<string, AgentResource>();
      for (const item of items) {
        const key = `${item.ecosystem}:${item.kind}:${displayName(item).toLowerCase()}`;
        const current = byName.get(key);
        if (!current || current.scope !== "project") {
          byName.set(key, item);
        }
      }
      return [...byName.values()].sort((left, right) => displayName(left).localeCompare(displayName(right)));
    };

    const skillResources = resources.filter((resource) => resource.kind === "skill" && scopedToProject(resource));
    const agentResources = resources.filter((resource) => resource.kind === "subagent" && scopedToProject(resource));
    const instructionResources = resources.filter(
      (resource) =>
        (resource.kind === "agents_md" || resource.kind === "claude_md" || resource.kind === "setting") &&
        scopedToProject(resource)
    );

    return {
      project: activeProject,
      skills: dedupeByName(skillResources),
      projectSkills: dedupeByName(skillResources.filter((resource) => resource.projectId === activeProjectId)),
      globalSkills: dedupeByName(skillResources.filter((resource) => resource.scope === "global")),
      agents: dedupeByName(agentResources),
      projectAgents: dedupeByName(agentResources.filter((resource) => resource.projectId === activeProjectId)),
      globalAgents: dedupeByName(agentResources.filter((resource) => resource.scope === "global")),
      instructions: instructionResources.sort((left, right) => left.path.localeCompare(right.path))
    };
  }, [activeProject, activeProjectId, scanResult]);

  const activeContextImpact = useMemo(() => {
    return buildActiveContextImpact(scanResult, activeProjectId, activeProject);
  }, [activeProject, activeProjectId, scanResult]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!selectedResourceId) {
      return;
    }

    fetchResourcePreview(selectedResourceId)
      .then(setPreview)
      .catch((cause: unknown) => setPreviewError(errorMessage(cause)));
  }, [selectedResourceId]);

  async function runScan(nextRoots = workspaceRoots) {
    setIsScanning(true);
    setError(null);
    try {
      const result = await scanWorkspaces(nextRoots);
      setScanResult(result);
      setSelectedResourceId(null);
      setSelectedProjectId(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsScanning(false);
    }
  }

  function addRoot(root: string) {
    const trimmed = root.trim();
    if (!trimmed || workspaceRoots.includes(trimmed)) {
      return;
    }
    setWorkspaceRoots([...workspaceRoots, trimmed]);
    setNewRoot("");
  }

  function removeRoot(root: string) {
    setWorkspaceRoots(workspaceRoots.filter((candidate) => candidate !== root));
  }

  const selectedProjectResources = selectedProject
    ? (scanResult?.resources ?? []).filter(
        (resource) => resource.projectId === selectedProject.id || resource.scope === "global"
      )
    : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Agent Board</h1>
          <p>Codex and Claude local configuration inventory</p>
        </div>
        <div className="global-status">
          <GlobalStatus label="Codex" exists={defaults?.globals.codex.exists} path={defaults?.globals.codex.path} />
          <GlobalStatus label="Claude" exists={defaults?.globals.claude.exists} path={defaults?.globals.claude.path} />
          <GlobalStatus label=".agents" exists={defaults?.globals.agents.exists} path={defaults?.globals.agents.path} />
        </div>
      </header>

      <section className="toolbar">
        <div className="roots-panel">
          <div className="section-label">Workspace Roots</div>
          <div className="root-list">
            {workspaceRoots.map((root) => (
              <span className="root-chip" key={root}>
                <span title={root}>{root}</span>
                <button type="button" onClick={() => removeRoot(root)} aria-label={`Remove ${root}`}>
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="root-controls">
            <input
              value={newRoot}
              onChange={(event) => setNewRoot(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  addRoot(newRoot);
                }
              }}
              placeholder="/absolute/workspace/path"
            />
            <button type="button" onClick={() => addRoot(newRoot)}>
              Add
            </button>
            {(defaults?.commonPaths ?? []).map((path) => (
              <button type="button" className="ghost-button" key={path} onClick={() => addRoot(path)}>
                Add {basename(path)}
              </button>
            ))}
            <button type="button" className="scan-button" disabled={isScanning} onClick={() => runScan()}>
              {isScanning ? "Scanning..." : "Scan"}
            </button>
          </div>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}
      {scanResult && scanResult.warnings.length > 0 ? (
        <div className="warning-banner">
          {scanResult.warnings.length} warning{scanResult.warnings.length === 1 ? "" : "s"} from the last scan
        </div>
      ) : null}

      <main className="dashboard-layout">
        <ProjectContextPanel
          context={projectContext}
          projects={scanResult?.projects ?? []}
          activeProjectId={activeProjectId}
          onSelectProject={setSelectedProjectId}
          onSelectResource={(resource) => {
            setSelectedResourceId(resource.id);
            setSelectedProjectId(resource.projectId ?? activeProjectId);
          }}
        />

        <section className="skill-board">
          <div className="skill-board-header">
            <div>
              <span className="card-kicker">Skill Availability</span>
              <h2>Which skills are global, and which projects have local skills?</h2>
            </div>
            <input
              value={skillSearch}
              onChange={(event) => setSkillSearch(event.target.value)}
              placeholder="Search skills or projects"
            />
          </div>
          <div className="skill-stats">
            <Metric label="Unique Skills" value={skillBoard.stats.unique} />
            <Metric label="Global Skills" value={skillBoard.stats.global} />
            <Metric label="Project-local" value={skillBoard.stats.projectLocal} />
            <Metric label="Both" value={skillBoard.stats.both} />
          </div>
          <SkillCoverageMatrix
            rows={skillBoard.filteredRows}
            projectById={projectById}
            onSelect={(resource) => {
              setSelectedResourceId(resource.id);
              setSelectedProjectId(resource.projectId ?? null);
            }}
          />
        </section>

        <section className="overview-grid">
          <div className="summary-card hero-card">
            <div>
              <span className="card-kicker">Scan Overview</span>
              <strong>{overview.totals.resources.toLocaleString()}</strong>
              <span>resources across {overview.totals.projects.toLocaleString()} projects</span>
            </div>
            <div className="hero-metrics">
              <Metric label="Global" value={overview.totals.global} />
              <Metric label="Warnings" value={overview.totals.warnings} tone={overview.totals.warnings > 0 ? "warn" : "ok"} />
              <Metric label="Links" value={overview.totals.relationships} />
            </div>
          </div>

          {scanResult?.configurationLoad ? (
            <>
              <ActiveContextImpactPanel impact={activeContextImpact} />
              <ConfigurationLoadPanel configurationLoad={scanResult.configurationLoad} />
            </>
          ) : null}

          <DistributionCard
            title="Ecosystem"
            items={[
              { label: "Codex", value: overview.byEcosystem.codex ?? 0, tone: "codex" },
              { label: "Claude", value: overview.byEcosystem.claude ?? 0, tone: "claude" }
            ]}
          />

          <DistributionCard
            title="Scope"
            items={[
              { label: "Global", value: overview.byScope.global ?? 0, tone: "global" },
              { label: "Project", value: overview.byScope.project ?? 0, tone: "project" },
              { label: "Nested", value: overview.byScope.nested ?? 0, tone: "nested" }
            ]}
          />

          <div className="summary-card">
            <div className="card-header">
              <span className="card-kicker">Top Kinds</span>
            </div>
            <BarList items={overview.byKind} />
          </div>

          <div className="summary-card wide-card">
            <div className="card-header">
              <span className="card-kicker">Project Hotspots</span>
              <span>{overview.topProjects.length} active</span>
            </div>
            <ProjectBars
              items={overview.topProjects}
              onSelect={(projectId) => setSelectedProjectId(projectId)}
            />
          </div>

          <div className="summary-card wide-card">
            <div className="card-header">
              <span className="card-kicker">Detected Skills</span>
              <span>{(scanResult?.resources ?? []).filter((resource) => resource.kind === "skill").length} total</span>
            </div>
            <div className="skill-cloud">
              {overview.topSkills.length === 0 ? (
                <span className="muted-text">No skills detected.</span>
              ) : (
                overview.topSkills.map((resource) => (
                  <button
                    type="button"
                    key={resource.id}
                    onClick={() => {
                      setSelectedResourceId(resource.id);
                      setSelectedProjectId(resource.projectId ?? null);
                    }}
                  >
                    {displayName(resource)}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="summary-card alert-card">
            <div className="card-header">
              <span className="card-kicker">Needs Attention</span>
              <span>{overview.attentionResources.length} shown</span>
            </div>
            <AttentionList
              resources={overview.attentionResources}
              onSelect={(resource) => {
                setSelectedResourceId(resource.id);
                setSelectedProjectId(resource.projectId ?? null);
              }}
            />
          </div>
        </section>

        <section className="content-grid">
        <section className="inventory-panel">
          <div className="panel-header">
            <div>
              <h2>Inventory</h2>
              <span>
                showing {visibleResources.length} of {filteredResources.length} filtered resources
              </span>
            </div>
            <span>{scanResult?.scannedAt ? new Date(scanResult.scannedAt).toLocaleString() : "Not scanned"}</span>
          </div>

          <FilterBar
            filters={filters}
            projects={scanResult?.projects ?? []}
            resources={scanResult?.resources ?? []}
            onChange={setFilters}
          />

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ecosystem</th>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Project</th>
                  <th>Scope</th>
                  <th>Confidence</th>
                  <th>Path</th>
                  <th>Scope Path</th>
                  <th>Tags</th>
                  <th>Status</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                {visibleResources.map((resource) => (
                  <tr
                    key={resource.id}
                    className={resource.id === selectedResourceId ? "selected-row" : ""}
                    onClick={() => {
                      setSelectedResourceId(resource.id);
                      setSelectedProjectId(resource.projectId ?? null);
                    }}
                  >
                    <td>
                      <Badge tone={resource.ecosystem}>{resource.ecosystem}</Badge>
                    </td>
                    <td className="name-cell" title={displayName(resource)}>
                      {displayName(resource)}
                    </td>
                    <td>{resource.kind}</td>
                    <td>
                      {resource.projectId ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedProjectId(resource.projectId ?? null);
                          }}
                        >
                          {projectById.get(resource.projectId)?.name ?? "unknown"}
                        </button>
                      ) : (
                        "global"
                      )}
                    </td>
                    <td>{resource.scope}</td>
                    <td>{resource.scopeConfidence}</td>
                    <td className="path-cell" title={resource.path}>
                      {resource.path}
                    </td>
                    <td className="path-cell" title={resource.scopePath}>
                      {resource.scopePath}
                    </td>
                    <td>
                      <TagList tags={resource.tags.slice(0, 4)} />
                    </td>
                    <td>
                      <Status status={resource.status} />
                    </td>
                    <td>{new Date(resource.mtime).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="detail-panel">
          <ResourceDetail
            resource={selectedResource}
            project={selectedResource?.projectId ? projectById.get(selectedResource.projectId) ?? null : null}
            relationships={selectedResourceId ? relationshipsByResource.get(selectedResourceId) ?? [] : []}
            preview={preview}
            previewError={previewError}
          />
          <ProjectDetail project={selectedProject} resources={selectedProjectResources} />
        </aside>
        </section>
      </main>
    </div>
  );
}

function ActiveContextImpactPanel({ impact }: { impact: ActiveContextImpact | null }) {
  if (!impact) {
    return (
      <div className="summary-card active-context-card">
        <div className="card-header">
          <div>
            <span className="card-kicker">Active Context Impact</span>
            <h2>Select a project</h2>
          </div>
        </div>
        <p className="load-footnote">Run a scan and select a project to estimate likely active Codex context.</p>
      </div>
    );
  }

  const localCandidates = impact.localSkillCandidates.length + impact.localToolCandidates.length;
  const globalCandidates = impact.globalSkillCandidates.length + impact.globalToolCandidates.length;

  return (
    <div className={`summary-card active-context-card impact-${impact.level}`}>
      <div className="card-header">
        <div>
          <span className="card-kicker">Active Context Impact</span>
          <h2>{impact.projectName}</h2>
        </div>
        <span className="load-level">{impact.level}</span>
      </div>
      <div className="load-score-row">
        <strong>{impact.score.toLocaleString()}</strong>
        <p>
          Likely Codex context for the selected project, compared with a default install. This uses readable files and
          configured MCP declarations; final runtime-loaded prompts and tool schemas still need live trace evidence.
        </p>
      </div>
      <div className="impact-metrics">
        <Metric label="Active rules" value={impact.alwaysLoaded.length} />
        <Metric label="Est. rule tokens" value={impact.instructionTokens} />
        <Metric label="MCP servers" value={impact.mcpServers.length} />
        <Metric label="Local candidates" value={localCandidates} />
      </div>
      <div className="load-subgrid">
        <div>
          <div className="section-row-title">
            <h3>Likely Always Loaded</h3>
            <span>{impact.alwaysLoaded.length}</span>
          </div>
          <div className="load-mini-list">
            {impact.alwaysLoaded.slice(0, 4).map((resource) => (
              <div key={resource.id}>
                <span title={resource.path}>
                  {displayName(resource)}
                  <small>{resource.scope}</small>
                </span>
                <strong>{Math.ceil(resource.size / 4).toLocaleString()}</strong>
              </div>
            ))}
            {impact.alwaysLoaded.length === 0 ? <p className="muted-text">No likely always-loaded rules detected.</p> : null}
          </div>
        </div>
        <div>
          <div className="section-row-title">
            <h3>Runtime Surface</h3>
            <span>{impact.evidenceLevel}</span>
          </div>
          <div className="impact-facts">
            <span><b>Configured:</b> {impact.mcpServers.length.toLocaleString()} MCP servers from readable Codex config.</span>
            <span><b>Likely local:</b> {localCandidates.toLocaleString()} project skills, commands, subagents, or plugins.</span>
            <span><b>Visible inventory:</b> {globalCandidates.toLocaleString()} global candidates, capped in score because activation is not proven.</span>
            <span><b>Not counted active:</b> {impact.globalRuleInventory.length.toLocaleString()} global config/rule files.</span>
            <span><b>Conditional:</b> {impact.conditionalRuleFiles.length.toLocaleString()} nested rule files depend on working directory.</span>
          </div>
        </div>
      </div>
      <p className="load-footnote">{impact.caveats.join(" ")}</p>
    </div>
  );
}

function ConfigurationLoadPanel({ configurationLoad }: { configurationLoad: ConfigurationLoadAnalysis }) {
  const topProjects = configurationLoad.projectSummaries
    .slice()
    .sort((left, right) => right.score - left.score || left.projectName.localeCompare(right.projectName))
    .slice(0, 4);

  return (
    <div className={`summary-card configuration-load-card load-${configurationLoad.level}`}>
      <div className="card-header">
        <div>
          <span className="card-kicker">Workspace Inventory</span>
          <h2>Scanned resource load</h2>
        </div>
        <span className="load-level">inventory {configurationLoad.level}</span>
      </div>
      <div className="load-score-row">
        <strong>{configurationLoad.score.toLocaleString()}</strong>
        <p>
          Broad inventory breadth across all scanned roots against the {formatBaseline(configurationLoad.baseline)}
          {" "}baseline. Use Active Context Impact for the selected-project view.
        </p>
      </div>
      <div className="load-category-list">
        {configurationLoad.categories.map((category) => (
          <div className="load-category-row" key={category.key}>
            <div>
              <span>{category.label}</span>
              <small title={category.detail}>
                {category.value.toLocaleString()} observed · {category.detail}
              </small>
            </div>
            <i>
              <b style={{ width: `${category.score}%` }} />
            </i>
            <strong>{category.score.toLocaleString()}</strong>
          </div>
        ))}
      </div>
      <div className="load-subgrid">
        <div>
          <div className="section-row-title">
            <h3>Top Contributors</h3>
            <span>{configurationLoad.topContributors.length}</span>
          </div>
          <div className="load-mini-list">
            {configurationLoad.topContributors.slice(0, 4).map((contributor) => (
              <div key={`${contributor.kind}-${contributor.label}-${contributor.projectName ?? "global"}`}>
                <span title={contributor.reason}>
                  {contributor.label}
                  {contributor.projectName ? <small>{contributor.projectName}</small> : null}
                </span>
                <strong>{contributor.score.toLocaleString()}</strong>
              </div>
            ))}
            {configurationLoad.topContributors.length === 0 ? (
              <p className="muted-text">No load contributors detected.</p>
            ) : null}
          </div>
        </div>
        <div>
          <div className="section-row-title">
            <h3>Project Load</h3>
            <span>{configurationLoad.projectSummaries.length}</span>
          </div>
          <div className="load-mini-list">
            {topProjects.map((project) => (
              <div key={project.projectId}>
                <span title={`${project.resourceCount.toLocaleString()} resources`}>
                  {project.projectName}
                  <small>{project.resourceCount.toLocaleString()} resources</small>
                </span>
                <strong>{project.score.toLocaleString()}</strong>
              </div>
            ))}
            {topProjects.length === 0 ? <p className="muted-text">No project-specific load detected.</p> : null}
          </div>
        </div>
      </div>
      <p className="load-footnote">
        Excludes {configurationLoad.excludedDefaultResources.toLocaleString()} default resource
        {configurationLoad.excludedDefaultResources === 1 ? "" : "s"}.
        {configurationLoad.measured
          ? ` Measured sample available from ${configurationLoad.measured.runs.toLocaleString()} run${
              configurationLoad.measured.runs === 1 ? "" : "s"
            }, but this score remains a static estimate.`
          : " No measured sample is attached."}
      </p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ""}`}>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function DistributionCard({
  title,
  items
}: {
  title: string;
  items: Array<{ label: string; value: number; tone: string }>;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="summary-card">
      <div className="card-header">
        <span className="card-kicker">{title}</span>
        <span>{total.toLocaleString()}</span>
      </div>
      <div className="stacked-bar" aria-label={`${title} distribution`}>
        {items.map((item) => (
          <span
            className={`stack-segment stack-${item.tone}`}
            key={item.label}
            style={{ width: `${total > 0 ? Math.max((item.value / total) * 100, item.value > 0 ? 7 : 0) : 0}%` }}
            title={`${item.label}: ${item.value}`}
          />
        ))}
      </div>
      <div className="legend-list">
        {items.map((item) => (
          <div key={item.label}>
            <span className={`legend-dot stack-${item.tone}`} />
            <span>{item.label}</span>
            <strong>{item.value.toLocaleString()}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function BarList({ items }: { items: Array<{ label: string; value: number }> }) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="bar-list">
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <span>{item.label}</span>
          <div>
            <i style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <strong>{item.value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

function ProjectBars({
  items,
  onSelect
}: {
  items: Array<{ project: Project; count: number }>;
  onSelect: (projectId: string) => void;
}) {
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className="project-bars">
      {items.map((item) => (
        <button type="button" key={item.project.id} onClick={() => onSelect(item.project.id)}>
          <span>{item.project.name}</span>
          <i>
            <b style={{ width: `${(item.count / max) * 100}%` }} />
          </i>
          <strong>{item.count.toLocaleString()}</strong>
        </button>
      ))}
    </div>
  );
}

function AttentionList({
  resources,
  onSelect
}: {
  resources: AgentResource[];
  onSelect: (resource: AgentResource) => void;
}) {
  if (resources.length === 0) {
    return <p className="muted-text">No duplicate, unreadable, or large resources detected.</p>;
  }

  return (
    <div className="attention-list">
      {resources.map((resource) => (
        <button type="button" key={resource.id} onClick={() => onSelect(resource)}>
          <span>{displayName(resource)}</span>
          <Status status={resource.status} />
        </button>
      ))}
    </div>
  );
}

function SkillCoverageMatrix({
  rows,
  projectById,
  onSelect
}: {
  rows: SkillCoverage[];
  projectById: Map<string, Project>;
  onSelect: (resource: AgentResource) => void;
}) {
  if (rows.length === 0) {
    return <p className="muted-text">No skills detected in global or project locations.</p>;
  }

  const lanes = [
    {
      key: "global",
      title: "GLOBAL",
      subtitle: "registered once, available broadly",
      rows: rows.filter((row) => row.globalResources.length > 0 && row.projectResources.length === 0),
      source: "~/.agents, ~/.codex, ~/.claude"
    },
    {
      key: "both",
      title: "GLOBAL + LOCAL",
      subtitle: "global skill also appears in projects",
      rows: rows.filter((row) => row.globalResources.length > 0 && row.projectResources.length > 0),
      source: "global + project roots"
    },
    {
      key: "project",
      title: "PROJECT LOCAL",
      subtitle: "only available inside project scope",
      rows: rows.filter((row) => row.globalResources.length === 0 && row.projectResources.length > 0),
      source: ".agents/skills in workspaces"
    }
  ];

  return (
    <div className="skill-matrix-wrap">
      <div className="scope-map-header">
        <span>SCOPE \ DEPTH</span>
        <span>SKILL INDEX</span>
        <span>PROJECT COVERAGE</span>
        <span>SOURCES</span>
      </div>
      <div className="scope-map">
        {lanes.map((lane) => (
          <section className={`scope-lane lane-${lane.key}`} key={lane.key}>
            <div className="scope-label">
              <strong>{lane.title}</strong>
              <span>{lane.subtitle}</span>
              <b>{lane.rows.length.toLocaleString()}</b>
            </div>
            <div className="skill-card-grid">
              {lane.rows.length === 0 ? (
                <p className="muted-text">No skills in this scope.</p>
              ) : (
                lane.rows.slice(0, 28).map((row) => (
                  <SkillMapCard
                    key={row.name}
                    row={row}
                    projectById={projectById}
                    onSelect={onSelect}
                  />
                ))
              )}
              {lane.rows.length > 28 ? <p className="lane-overflow">+{lane.rows.length - 28} more</p> : null}
            </div>
            <div className="coverage-panel">
              {lane.key === "global" ? (
                <span className="coverage-copy">Available to all scanned projects through global registration.</span>
              ) : (
                <ProjectChipList rows={lane.rows} projectById={projectById} />
              )}
            </div>
            <div className="source-panel">
              <strong>{lane.source}</strong>
              <span>{lane.rows.reduce((sum, row) => sum + row.resources.length, 0).toLocaleString()} skill files</span>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ProjectContextPanel({
  context,
  projects,
  activeProjectId,
  onSelectProject,
  onSelectResource
}: {
  context: ProjectContext;
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onSelectResource: (resource: AgentResource) => void;
}) {
  return (
    <section className="project-context-board">
      <div className="project-context-header">
        <div>
          <span className="card-kicker">Project Active Context</span>
          <h2>{context.project ? context.project.name : "Select a project"}</h2>
          <p>
            Shows the skills, subagents, and instruction files that are global or local to the selected project.
          </p>
        </div>
        <select
          value={activeProjectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value || null)}
        >
          <option value="">select project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="context-metrics">
        <Metric label="Available Skills" value={context.skills.length} />
        <Metric label="Project Skills" value={context.projectSkills.length} />
        <Metric label="Available Agents" value={context.agents.length} />
        <Metric label="Instructions" value={context.instructions.length} />
      </div>

      <div className="context-columns">
        <ContextList
          title="Global Skills"
          tone="global"
          items={context.globalSkills}
          empty="No global skills detected."
          onSelect={onSelectResource}
        />
        <ContextList
          title="Project-local Skills"
          tone="project"
          items={context.projectSkills}
          empty="No project-local skills detected."
          onSelect={onSelectResource}
        />
        <ContextList
          title="Agents / Subagents"
          tone="agent"
          items={context.agents}
          empty="No agents detected."
          onSelect={onSelectResource}
        />
        <ContextList
          title="Instructions"
          tone="docs"
          items={context.instructions}
          empty="No instruction files detected."
          onSelect={onSelectResource}
        />
      </div>
      <p className="context-note">
        Scope is inferred from local files: global entries are broadly available; project-local entries come from files
        inside the selected project. Tool-specific runtime loading can still differ.
      </p>
    </section>
  );
}

function ContextList({
  title,
  tone,
  items,
  empty,
  onSelect,
  limit = 18
}: {
  title: string;
  tone: "global" | "project" | "agent" | "docs";
  items: AgentResource[];
  empty: string;
  onSelect: (resource: AgentResource) => void;
  limit?: number;
}) {
  const visibleItems = items.slice(0, limit);

  return (
    <div className={`context-list context-${tone}`}>
      <div className="context-list-title">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <div className="context-pills">
          {visibleItems.map((item) => (
            <button key={item.id} type="button" onClick={() => onSelect(item)} title={item.path}>
              <strong>{displayName(item)}</strong>
              <span>{item.ecosystem} / {item.scope}</span>
            </button>
          ))}
          {items.length > visibleItems.length ? (
            <span className="context-more">+{items.length - visibleItems.length} more</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SkillMapCard({
  row,
  projectById,
  onSelect
}: {
  row: SkillCoverage;
  projectById: Map<string, Project>;
  onSelect: (resource: AgentResource) => void;
}) {
  const firstResource = row.projectResources[0] ?? row.globalResources[0] ?? row.resources[0];
  const localProjects = row.projectIds
    .map((projectId) => projectById.get(projectId)?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <button type="button" className="skill-map-card" onClick={() => firstResource && onSelect(firstResource)}>
      <strong>{row.name}</strong>
      <span>{row.ecosystems.join(" / ")}</span>
      <small>
        {row.globalResources.length > 0 ? "global" : "local"}
        {localProjects.length > 0 ? ` · ${localProjects.slice(0, 2).join(", ")}` : ""}
      </small>
    </button>
  );
}

function ProjectChipList({
  rows,
  projectById
}: {
  rows: SkillCoverage[];
  projectById: Map<string, Project>;
}) {
  const projectIds = [...new Set(rows.flatMap((row) => row.projectIds))];
  if (projectIds.length === 0) {
    return <span className="coverage-copy">No local project coverage.</span>;
  }

  return (
    <div className="project-chip-list">
      {projectIds.slice(0, 12).map((projectId) => (
        <span key={projectId} title={projectById.get(projectId)?.rootPath}>
          {projectById.get(projectId)?.name ?? "unknown"}
        </span>
      ))}
      {projectIds.length > 12 ? <em>+{projectIds.length - 12}</em> : null}
    </div>
  );
}

function FilterBar({
  filters,
  projects,
  resources,
  onChange
}: {
  filters: Filters;
  projects: Project[];
  resources: AgentResource[];
  onChange: (filters: Filters) => void;
}) {
  return (
    <div className="filter-bar">
      <input
        value={filters.query}
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
        placeholder="Search paths, summaries, projects"
      />
      <SelectFilter
        value={filters.ecosystem}
        values={unique(resources.map((resource) => resource.ecosystem))}
        onChange={(value) => onChange({ ...filters, ecosystem: value })}
      />
      <SelectFilter
        value={filters.kind}
        values={unique(resources.map((resource) => resource.kind))}
        onChange={(value) => onChange({ ...filters, kind: value })}
      />
      <SelectFilter
        value={filters.scope}
        values={unique(resources.map((resource) => resource.scope))}
        onChange={(value) => onChange({ ...filters, scope: value })}
      />
      <SelectFilter
        value={filters.status}
        values={unique(resources.map((resource) => resource.status))}
        onChange={(value) => onChange({ ...filters, status: value })}
      />
      <select value={filters.project} onChange={(event) => onChange({ ...filters, project: event.target.value })}>
        <option value={allOption}>all projects</option>
        {projects.map((project) => (
          <option value={project.id} key={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function SelectFilter({
  value,
  values,
  onChange
}: {
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value={allOption}>all</option>
      {values.map((candidate) => (
        <option value={candidate} key={candidate}>
          {candidate}
        </option>
      ))}
    </select>
  );
}

function ResourceDetail({
  resource,
  project,
  relationships,
  preview,
  previewError
}: {
  resource: AgentResource | null;
  project: Project | null;
  relationships: Relationship[];
  preview: ResourcePreview | null;
  previewError: string | null;
}) {
  if (!resource) {
    return (
      <section className="detail-card empty-detail">
        <h2>Resource</h2>
        <p>Select a row to inspect scope, relationships, and preview.</p>
      </section>
    );
  }

  return (
    <section className="detail-card">
      <div className="detail-heading">
        <div>
        <h2>{displayName(resource)}</h2>
          <span className="detail-subtitle">{resource.kind}</span>
        </div>
        <Badge tone={resource.ecosystem}>{resource.ecosystem}</Badge>
      </div>
      <dl>
        <dt>Project</dt>
        <dd>{project?.name ?? "global"}</dd>
        <dt>Path</dt>
        <dd title={resource.path}>{resource.path}</dd>
        <dt>Detected scope</dt>
        <dd title={resource.scopePath}>
          {resource.scope} / {resource.scopeConfidence}
        </dd>
        <dt>Summary</dt>
        <dd>{resource.summary}</dd>
      </dl>
      <TagList tags={resource.tags} />
      <RelationshipSummary relationships={relationships} />
      <div className="preview-box">
        <h3>Preview</h3>
        {previewError ? <p className="inline-error">{previewError}</p> : null}
        {!preview && !previewError ? <p>Loading preview...</p> : null}
        {preview ? (
          <>
            {preview.truncated ? <p className="preview-note">Preview truncated at 200KB.</p> : null}
            <pre>{preview.content}</pre>
          </>
        ) : null}
      </div>
    </section>
  );
}

function RelationshipSummary({ relationships }: { relationships: Relationship[] }) {
  if (relationships.length === 0) {
    return (
      <div className="relationship-summary">
        <div className="section-row-title">
          <h3>Relationships</h3>
          <span>0</span>
        </div>
        <p>No relationships detected.</p>
      </div>
    );
  }

  const counts = countBy(relationships, (relationship) => relationship.type);
  const compact = topEntries(counts, 4);

  return (
    <div className="relationship-summary">
      <div className="section-row-title">
        <h3>Relationships</h3>
        <span>{relationships.length}</span>
      </div>
      <div className="relationship-chips">
        {compact.map((item) => (
          <span key={item.label} title={relationshipLabel(item.label)}>
            {shortRelationshipLabel(item.label)}
            <b>{item.value}</b>
          </span>
        ))}
      </div>
      <div className="relationship-mini-list">
        {relationships.slice(0, 3).map((relationship, index) => (
          <span key={`${relationship.type}-${index}`} title={relationship.reason}>
            {shortRelationshipLabel(relationship.type)}
          </span>
        ))}
        {relationships.length > 3 ? <em>+{relationships.length - 3} more</em> : null}
      </div>
    </div>
  );
}

function ProjectDetail({ project, resources }: { project: Project | null; resources: AgentResource[] }) {
  if (!project) {
    return null;
  }

  return (
    <section className="detail-card project-card">
      <h2>{project.name}</h2>
      <dl>
        <dt>Root</dt>
        <dd title={project.rootPath}>{project.rootPath}</dd>
        <dt>Detected by</dt>
        <dd>{project.detectedBy}</dd>
        <dt>Resources</dt>
        <dd>{resources.length}</dd>
      </dl>
      <div className="mini-list">
        {resources.slice(0, 12).map((resource) => (
          <div key={resource.id}>
            <span>{displayName(resource)}</span>
            <small title={resource.path}>{resource.scope}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function GlobalStatus({ label, exists, path }: { label: string; exists?: boolean; path?: string }) {
  return (
    <div className="global-pill" title={path}>
      <span className={exists ? "dot ok" : "dot missing"} />
      {label}
    </div>
  );
}

function Badge({ children, tone }: { children: string; tone: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Status({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <div className="tags">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  );
}

function readSavedRoots(): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function topEntries(counts: Record<string, number>, limit: number): Array<{ label: string; value: number }> {
  return Object.entries(counts)
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function statusWeight(status: string): number {
  switch (status) {
    case "unreadable":
      return 4;
    case "duplicate_candidate":
      return 3;
    case "skipped_large":
      return 2;
    default:
      return 1;
  }
}

function shortRelationshipLabel(type: string): string {
  switch (type) {
    case "inherited_from_global":
      return "global";
    case "duplicate_candidate":
      return "duplicate";
    case "shadowed_by":
      return "shadowed";
    case "shadows":
      return "shadows";
    default:
      return type;
  }
}

function relationshipLabel(type: string): string {
  switch (type) {
    case "inherited_from_global":
      return "Inherited from a global resource";
    case "duplicate_candidate":
      return "Potential duplicate with a similar resource";
    case "shadowed_by":
      return "This resource may be overridden by another resource";
    case "shadows":
      return "This resource may override another resource";
    default:
      return type;
  }
}

function formatBaseline(baseline: string): string {
  return baseline.replaceAll("_", " ");
}

function buildActiveContextImpact(
  scanResult: ScanResult | null,
  activeProjectId: string | null,
  activeProject: Project | null
): ActiveContextImpact | null {
  if (!scanResult || !activeProjectId || !activeProject) {
    return null;
  }

  const appliesToActiveProject = (resource: AgentResource) =>
    resource.scope === "global" || resource.projectId === activeProjectId;
  const allAgentsResources = scanResult.resources.filter(
    (resource) =>
      resource.ecosystem === "codex" &&
      resource.kind === "agents_md" &&
      !isDefaultCodexResourcePath(resource.path)
  );
  const activeAgentsFiles = dedupeEffectiveResources(allAgentsResources
    .filter((resource) => isAncestorOrSame(dirname(resource.path), activeProject.rootPath)))
    .sort((left, right) => left.path.localeCompare(right.path));
  const conditionalAgentsFiles = dedupeEffectiveResources(allAgentsResources
    .filter(
      (resource) => isAncestorOrSame(activeProject.rootPath, dirname(resource.path)) && dirname(resource.path) !== activeProject.rootPath
    ))
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const codexResources = scanResult.resources.filter(
    (resource) => resource.ecosystem === "codex" && appliesToActiveProject(resource) && !isDefaultCodexResourcePath(resource.path)
  );
  const activeResources = dedupeResources([...codexResources, ...activeAgentsFiles]);
  const ruleFiles = codexResources.filter((resource) =>
    ["agents_md", "setting", "omx", "automation"].includes(resource.kind)
  );
  const isCodexConfig = (resource: AgentResource) => basename(resource.path).toLowerCase() === "config.toml";
  const configuredProjectSettings = activeResources
    .filter((resource) => resource.scope === "project" && isCodexConfig(resource));
  const alwaysLoaded = dedupeResources(activeAgentsFiles)
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const globalRuleInventory = ruleFiles
    .filter(
      (resource) => resource.scope === "global" && resource.kind !== "agents_md" && !isCodexConfig(resource)
    )
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const conditionalRuleFiles = ruleFiles
    .filter(
      (resource) =>
        resource.scope === "nested" ||
        (resource.kind === "agents_md" && isAncestorOrSame(activeProject.rootPath, dirname(resource.path)) && dirname(resource.path) !== activeProject.rootPath)
    )
    .concat(conditionalAgentsFiles)
    .filter((resource, index, resources) => resources.findIndex((candidate) => candidate.id === resource.id) === index)
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const skillCandidates = codexResources.filter((resource) => resource.kind === "skill");
  const toolCandidates = codexResources.filter((resource) =>
    ["command", "subagent", "plugin", "mcp"].includes(resource.kind)
  );
  const mcpServers = scanResult.configurationLoad.mcpServers.filter(
    (server) => !server.projectId || server.projectId === activeProjectId
  );
  const localSkillCandidates = skillCandidates.filter((resource) => resource.projectId === activeProjectId);
  const globalSkillCandidates = skillCandidates.filter((resource) => resource.scope === "global");
  const localToolCandidates = toolCandidates.filter((resource) => resource.projectId === activeProjectId);
  const globalToolCandidates = toolCandidates.filter((resource) => resource.scope === "global");
  const instructionTokens = Math.ceil(alwaysLoaded.reduce((sum, resource) => sum + resource.size, 0) / 4);
  const promptScore = Math.min(100, (instructionTokens / 30000) * 100);
  const globalCandidateUnits = Math.min((globalSkillCandidates.length + globalToolCandidates.length) * 0.05, 10);
  const runtimeSurfaceScore = Math.min(
    100,
    ((localSkillCandidates.length + localToolCandidates.length + mcpServers.length * 5 + globalCandidateUnits) / 80) * 100
  );
  const scopeScore = Math.min(100, (conditionalRuleFiles.length / 10) * 100);
  const score = Math.round(promptScore * 0.55 + runtimeSurfaceScore * 0.35 + scopeScore * 0.1);
  const confidence = codexResources.some((resource) => resource.scopeConfidence === "inferred") ? "inferred" : "exact";
  const evidenceLevel =
    confidence === "exact" && mcpServers.length + alwaysLoaded.length + localSkillCandidates.length + localToolCandidates.length > 0
      ? "file-backed"
      : "mixed-estimate";
  const caveats = [
    "Nested rule files are conditional and not counted as likely always loaded.",
    "Global skills and plugins are visible inventory, not treated as active session surface.",
    "Project config files are treated as configured runtime settings, not prompt-loaded rule text.",
    "Exact loaded tool registry and final prompt still require Codex trace, session metadata, or measured runs."
  ];

  if (configuredProjectSettings.length > 0) {
    caveats.unshift(`${configuredProjectSettings.length.toLocaleString()} project config file${configuredProjectSettings.length === 1 ? "" : "s"} counted as runtime configuration only.`);
  }

  if (confidence === "inferred") {
    caveats.unshift("Some scopes are inferred from file layout.");
  }

  return {
    projectName: activeProject.name,
    score,
    level: activeImpactLevel(score),
    confidence,
    evidenceLevel,
    instructionTokens,
    ruleFiles,
    globalRuleInventory,
    conditionalRuleFiles,
    localSkillCandidates,
    globalSkillCandidates,
    localToolCandidates,
    globalToolCandidates,
    mcpServers,
    alwaysLoaded,
    caveats
  };
}

function activeImpactLevel(score: number): ActiveContextImpact["level"] {
  if (score >= 67) {
    return "high";
  }
  if (score >= 34) {
    return "moderate";
  }
  return "low";
}

function isDefaultCodexResourcePath(resourcePath: string): boolean {
  const normalized = resourcePath.split("/").join("/");
  return (
    normalized.includes("/.codex/skills/.system/") ||
    normalized.includes("/.codex/plugins/cache/openai-bundled/") ||
    normalized.includes("/.codex/plugins/cache/openai-primary-runtime/")
  );
}

function dedupeResources(resources: AgentResource[]): AgentResource[] {
  return [...new Map(resources.map((resource) => [resource.id, resource])).values()];
}

function dedupeEffectiveResources(resources: AgentResource[]): AgentResource[] {
  return [...new Map(resources.map((resource) => [resource.effectiveResourceKey ?? resource.id, resource])).values()];
}

function displayName(resource: AgentResource): string {
  if (resource.name?.trim()) {
    return resource.name;
  }

  const fileName = basename(resource.path);
  const parentName = basename(resource.path.split("/").slice(0, -1).join("/"));
  if (resource.kind === "skill" && fileName.toLowerCase() === "skill.md") {
    return parentName;
  }

  const extensionIndex = fileName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  if (resource.kind === "agents_md") {
    return "AGENTS.md";
  }
  if (resource.kind === "claude_md") {
    return "CLAUDE.md";
  }

  return stem || resource.kind;
}

function basename(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

function dirname(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return filePath.startsWith("/") ? "/" : "";
  }

  return `${filePath.startsWith("/") ? "/" : ""}${parts.slice(0, -1).join("/")}`;
}

function isAncestorOrSame(candidateAncestor: string, targetPath: string): boolean {
  const ancestor = normalizePath(candidateAncestor);
  const target = normalizePath(targetPath);
  return target === ancestor || target.startsWith(`${ancestor}/`);
}

function normalizePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}
