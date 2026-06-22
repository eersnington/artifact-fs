export type AgentState = {
  agentId: string;
  repoName: string;
  mountPath: string;
  phase: "starting" | "mounted" | "running" | "dirty" | "done" | "failed";
  step: string;
  head: string | null;
  commit: string | null;
  error: string | null;
  updatedAt: number;
};

export type ArtifactFsEvent = {
  id?: string;
  repoId: string;
  repoName?: string;
  kind: string;
  at?: string;
  headOid?: string;
  headRef?: string;
  generation?: number;
  path?: string;
  objectOid?: string;
  sizeBytes?: number;
  error?: string;
  state?: string;
  dirtyOverlay?: boolean;
  hydratedBlobCount?: number;
  hydratedBlobBytes?: number;
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
  desiredRepos: DesiredRepo[];
  artifactFsEvents: ArtifactFsEvent[];
};

export type DesiredReposResponse = {
  source: string;
  authoritative: boolean;
  repos: DesiredRepo[];
};

export type WarmupRequest = {
  repoId: string;
  repoName: string;
  headOid: string;
  headRef: string;
  generation: number;
  toolProfile?: string;
  maxFiles?: number;
  maxBytes?: number;
};

export type WarmupPlanResponse = {
  tasks: Array<{
    repoId: string;
    path: string;
    priority: number;
    reason: string;
  }>;
};

export type CredentialRequest = {
  repoId: string;
  repoName: string;
  remoteUrl: string;
  secretRef?: string;
};

export type CredentialEnvResponse = {
  safeRemoteUrl: string;
  env: string[];
  expiresAt?: string;
};
