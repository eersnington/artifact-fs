import { actor, event, setup } from "rivetkit";
import type {
  ArtifactFsEvent,
  CredentialEnvResponse,
  CredentialRequest,
  DesiredRepo,
  DesiredReposResponse,
  RunState,
  WarmupPlanResponse,
  WarmupRequest,
} from "./events.js";
import type { StartRequest } from "./simulate.js";

const SOURCE = "rivet-artifact-sandbox";
const MAX_EVENTS = 500;
const WARMUP_PATHS = ["README.md", "package.json", "go.mod"];

type WorkspaceState = {
  run: RunState | null;
  desiredRepos: Record<string, DesiredRepo>;
  artifactFsEvents: ArtifactFsEvent[];
  warmupPaths: string[];
};

export const workspaceActor = actor({
  state: {
    run: null,
    desiredRepos: {},
    artifactFsEvents: [],
    warmupPaths: WARMUP_PATHS,
  } as WorkspaceState,
  events: {
    changed: event<RunState>(),
  },
  actions: {
    startRun: (c, request: StartRequest) => {
      const startedAt = Date.now();
      const desiredRepos = Object.fromEntries(
        Array.from({ length: request.agents }, (_, index) => {
          const name = `agent-${index + 1}`;
          return [name, desiredRepo({ name, request })];
        }),
      );
      const run: RunState = {
        runId: request.runId,
        remote: request.remote,
        branch: request.branch,
        scenario: request.scenario,
        agents: request.agents,
        state: "running",
        startedAt,
        updatedAt: startedAt,
        agentStates: [],
        desiredRepos: Object.values(desiredRepos),
        artifactFsEvents: c.state.artifactFsEvents,
      };
      c.state.run = run;
      c.state.desiredRepos = desiredRepos;
      c.broadcast("changed", run);
      return run;
    },
    recordRunState: (c, state: RunState) => {
      const next = withActorFields(state, c.state);
      c.state.run = next;
      c.broadcast("changed", next);
      return next;
    },
    getRunState: (c) => c.state.run ? withActorFields(c.state.run, c.state) : null,
    desiredRepos: (c): DesiredReposResponse => ({
      source: SOURCE,
      authoritative: c.state.run !== null,
      repos: Object.values(c.state.desiredRepos),
    }),
    recordArtifactFsEvent: (c, eventValue: ArtifactFsEvent) => {
      c.state.artifactFsEvents = [...c.state.artifactFsEvents, eventValue].slice(-MAX_EVENTS);
      if (eventValue.path && (eventValue.kind === "hydration.queued" || eventValue.kind === "hydration.complete")) {
        c.state.warmupPaths = [...new Set([eventValue.path, ...c.state.warmupPaths])].slice(0, 32);
      }
      if (c.state.run) {
        c.state.run = withActorFields(c.state.run, c.state);
        c.broadcast("changed", c.state.run);
      }
    },
    warmupPlan: (c, request: WarmupRequest): WarmupPlanResponse => ({
      tasks: c.state.warmupPaths.slice(0, request.maxFiles || 16).map((path) => ({
        repoId: request.repoId,
        path,
        priority: 700,
        reason: "rivet sandbox warmup",
      })),
    }),
    credentialEnv: (_c, request: CredentialRequest): CredentialEnvResponse => {
      if (request.secretRef) {
        throw new Error(`secret ref ${request.secretRef} is not configured in this public sandbox; use a public remote or add a demo secret provider`);
      }
      return {
        safeRemoteUrl: request.remoteUrl,
        env: ["GIT_TERMINAL_PROMPT=0"],
      };
    },
  },
});

export const registry = setup({
  use: {
    workspaceActor,
  },
  serverless: {
    basePath: "/api/rivet",
  },
  test: {
    enabled: true,
  },
});

export function createLocalWorkspace() {
  const state: WorkspaceState = {
    run: null,
    desiredRepos: {},
    artifactFsEvents: [],
    warmupPaths: WARMUP_PATHS,
  };
  return {
    async startRun(request: StartRequest): Promise<RunState> {
      const startedAt = Date.now();
      const desiredRepos = Object.fromEntries(
        Array.from({ length: request.agents }, (_, index) => {
          const name = `agent-${index + 1}`;
          return [name, desiredRepo({ name, request })];
        }),
      );
      state.desiredRepos = desiredRepos;
      state.run = withActorFields({
        runId: request.runId,
        remote: request.remote,
        branch: request.branch,
        scenario: request.scenario,
        agents: request.agents,
        state: "running",
        startedAt,
        updatedAt: startedAt,
        agentStates: [],
        desiredRepos: [],
        artifactFsEvents: [],
      }, state);
      return state.run;
    },
    async recordRunState(runState: RunState): Promise<RunState> {
      state.run = withActorFields(runState, state);
      return state.run;
    },
    async getRunState(): Promise<RunState | null> {
      return state.run ? withActorFields(state.run, state) : null;
    },
    async desiredRepos(): Promise<DesiredReposResponse> {
      return {
        source: SOURCE,
        authoritative: state.run !== null,
        repos: Object.values(state.desiredRepos),
      };
    },
    async recordArtifactFsEvent(eventValue: ArtifactFsEvent): Promise<void> {
      state.artifactFsEvents = [...state.artifactFsEvents, eventValue].slice(-MAX_EVENTS);
      if (eventValue.path && (eventValue.kind === "hydration.queued" || eventValue.kind === "hydration.complete")) {
        state.warmupPaths = [...new Set([eventValue.path, ...state.warmupPaths])].slice(0, 32);
      }
      if (state.run) {
        state.run = withActorFields(state.run, state);
      }
    },
    async warmupPlan(request: WarmupRequest): Promise<WarmupPlanResponse> {
      return {
        tasks: state.warmupPaths.slice(0, request.maxFiles || 16).map((path) => ({
          repoId: request.repoId,
          path,
          priority: 700,
          reason: "rivet sandbox warmup",
        })),
      };
    },
    async credentialEnv(request: CredentialRequest): Promise<CredentialEnvResponse> {
      if (request.secretRef) {
        throw new Error(`secret ref ${request.secretRef} is not configured in this public sandbox; use a public remote or add a demo secret provider`);
      }
      return {
        safeRemoteUrl: request.remoteUrl,
        env: ["GIT_TERMINAL_PROMPT=0"],
      };
    },
  };
}

function desiredRepo({ name, request }: { name: string; request: StartRequest }): DesiredRepo {
  return {
    id: name,
    name,
    remoteUrl: request.remote,
    branch: request.branch,
    refreshIntervalSeconds: 30,
    enabled: true,
    desiredOwner: SOURCE,
  };
}

function withActorFields(state: RunState, actorState: WorkspaceState): RunState {
  return {
    ...state,
    desiredRepos: Object.values(actorState.desiredRepos),
    artifactFsEvents: actorState.artifactFsEvents,
  };
}
