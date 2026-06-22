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
};

export type Stage = {
  key: string;
  label: string;
  description: string;
  index: number;
};

export const stages: Stage[] = [
  { key: "register", label: "Register repo", description: "artifact-fs add-repo registered an isolated repo name.", index: 0 },
  { key: "mount", label: "Mount tree", description: "ArtifactFS exposed that repo as a working tree.", index: 1 },
  { key: "warm", label: "Warm reads", description: "The agent read common files through the mounted tree.", index: 2 },
  { key: "write", label: "Write result", description: "The agent wrote demo-agent-output/<agent>.md.", index: 3 },
  { key: "commit", label: "Commit result", description: "Git created a result commit inside the working tree.", index: 4 },
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
