export type AgentPhase = "starting" | "mounted" | "running" | "dirty" | "done" | "failed";

export type AgentState = {
  agentId: string;
  repoName: string;
  mountPath: string;
  phase: AgentPhase;
  step: string;
  head: string | null;
  commit: string | null;
  error: string | null;
  updatedAt: number;
};

export type DesiredRepo = {
  id: string;
  name: string;
  remoteUrl: string;
  branch: string;
  refreshIntervalSeconds: number;
  enabled: boolean;
  desiredOwner: string;
};

export type ArtifactFsEvent = {
  id?: string;
  repoId: string;
  repoName?: string;
  kind: string;
  at?: string;
  generation?: number;
  path?: string;
  objectOid?: string;
  state?: string;
};

export type MilestoneEvent = {
  key: string;
  kind: string;
  repo: string;
  detail: string;
  why: string;
  count: number;
};

export type RunState = {
  runId: string;
  remote: string;
  branch: string;
  scenario: string;
  agents: number;
  state: "running" | "done" | "failed";
  startedAt: number;
  updatedAt: number;
  agentStates: AgentState[];
  desiredRepos?: DesiredRepo[];
  artifactFsEvents?: ArtifactFsEvent[];
};

export type Stage = {
  key: string;
  label: string;
  description: string;
  index: number;
};

export const stages: Stage[] = [
  { key: "register", label: "Rivet requests workspaces", description: "Actor state says each agent should get its own Git workspace.", index: 0 },
  { key: "mount", label: "ArtifactFS mounts folders", description: "The daemon exposes /workspace/mnt/agent-* as writable Git working trees.", index: 1 },
  { key: "warm", label: "Agents read files", description: "Reads go through ArtifactFS and hydrate blobs locally.", index: 2 },
  { key: "write", label: "Agents write outputs", description: "Writes land in ArtifactFS' local overlay, not in Rivet.", index: 3 },
  { key: "commit", label: "Git commits created", description: "Each agent commits its result inside its mounted folder.", index: 4 },
];

export function stageIndex(agent: AgentState): number {
  if (agent.phase === "done") {
    return 5;
  }
  if (agent.step === "committing result") {
    return 4;
  }
  if (agent.phase === "dirty" || agent.step === "writing result") {
    return 3;
  }
  if (agent.step === "warming files") {
    return 2;
  }
  if (agent.phase === "mounted" || agent.step === "mounted" || agent.step === "waiting for mount") {
    return 1;
  }
  return 0;
}

export function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "not available";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "not available";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatTime(value: number): string {
  if (!value) {
    return "not available";
  }
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function inferOutcome(state: RunState): string {
  const agents = state.agentStates;
  if (agents.length === 0) {
    return "No agent state has been written yet. Wait for the sidecar to publish the first run update.";
  }

  const done = agents.filter((agent) => agent.phase === "done").length;
  const failed = agents.filter((agent) => agent.phase === "failed");
  const commitCount = new Set(agents.flatMap((agent) => agent.commit ? [agent.commit] : [])).size;

  if (state.state === "failed") {
    const firstFailed = failed[0];
    const location = firstFailed ? `${firstFailed.agentId} at ${firstFailed.step}` : "an unknown agent";
    return `This run did not prove the full path. The first failed boundary is ${location}; inspect the failed agent below before drawing conclusions.`;
  }

  if (state.state === "done") {
    return `This run reached the commit boundary for every agent. ArtifactFS mounted each registered repo, accepted writes through the working tree, and Git created ${commitCount} result commits.`;
  }

  return `${done} of ${agents.length} agents have committed so far. The stalled stage tells you whether registration, mount readiness, file IO, or Git commit is the current boundary.`;
}

export function currentRunAgentCount(state: RunState): number {
  return state.agentStates.length || state.agents;
}

export function materializedWorkspaceCount(state: RunState): number {
  return state.agentStates.filter((agent) => stageIndex(agent) >= 1 || agent.phase === "done").length;
}

export function commitCount(state: RunState): number {
  return new Set(state.agentStates.flatMap((agent) => agent.commit ? [agent.commit] : [])).size;
}

export function summarizeMilestoneEvents(events: ArtifactFsEvent[] = []): MilestoneEvent[] {
  const priority = new Map([
    ["mount.ready", 0],
    ["mount.attempted", 1],
    ["snapshot.published", 2],
    ["head.changed", 3],
    ["hydration.complete", 4],
    ["hydration.queued", 5],
    ["fetch.succeeded", 6],
    ["overlay.dirty", 7],
    ["overlay.clean", 8],
    ["repo.disabled", 9],
    ["repo.desired", 10],
  ]);
  const rows = new Map<string, MilestoneEvent>();

  for (const event of events) {
    const repo = event.repoName || event.repoId || "workspace";
    const key = event.kind === "repo.desired"
      ? `${event.kind}:${repo}`
      : `${event.kind}:${repo}:${event.generation || ""}:${event.path || event.objectOid || ""}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    rows.set(key, {
      key,
      kind: event.kind,
      repo,
      detail: eventDetail(event),
      why: eventWhy(event.kind),
      count: 1,
    });
  }

  return Array.from(rows.values())
    .sort((a, b) => (priority.get(a.kind) ?? 99) - (priority.get(b.kind) ?? 99))
    .slice(0, 10);
}

function eventDetail(event: ArtifactFsEvent): string {
  if (event.path) {
    return event.path;
  }
  if (event.generation) {
    return `generation ${event.generation}`;
  }
  if (event.state) {
    return event.state;
  }
  return "-";
}

function eventWhy(kind: string): string {
  switch (kind) {
    case "repo.desired":
      return "Rivet kept this workspace in desired state.";
    case "mount.attempted":
      return "ArtifactFS started materializing the workspace.";
    case "mount.ready":
      return "ArtifactFS exposed a writable Git-backed folder.";
    case "hydration.queued":
      return "A blob warmup was requested outside the read hot path.";
    case "hydration.complete":
      return "A Git blob was hydrated into the local cache.";
    case "snapshot.published":
      return "ArtifactFS published a Git tree snapshot.";
    case "head.changed":
      return "A commit changed the workspace HEAD.";
    case "fetch.succeeded":
      return "The daemon refreshed remote Git state.";
    case "overlay.dirty":
      return "Local writes made the workspace dirty.";
    case "overlay.clean":
      return "Local overlay writes were committed or cleared.";
    case "repo.disabled":
      return "Rivet removed this workspace from desired state.";
    default:
      return "ArtifactFS recorded a runtime event.";
  }
}

export function phaseBadgeVariant(phase: AgentPhase | RunState["state"]): "success" | "warning" | "error" | "neutral" {
  if (phase === "done") {
    return "success";
  }
  if (phase === "failed") {
    return "error";
  }
  if (phase === "running" || phase === "dirty" || phase === "mounted") {
    return "warning";
  }
  return "neutral";
}

export function stageCount(stage: Stage, agents: AgentState[]): string {
  const total = agents.length;
  if (total === 0) {
    return "0 / 0";
  }
  const count = agents.filter((agent) => stageIndex(agent) > stage.index || agent.phase === "done").length;
  return `${count} / ${total}`;
}
