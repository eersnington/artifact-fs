import path from "node:path";
import { artifactStatus, gitCommit, gitHead, readMaybe, writeText } from "./artifactfs.js";
import type { AgentState, RunState } from "./events.js";

export type StartRequest = {
  runId: string;
  remote: string;
  branch: string;
  agents: number;
  scenario: string;
};

const mountRoot = process.env.MOUNT_ROOT ?? "/workspace/mnt";

export type RunStateRecorder = {
  recordRunState(state: RunState): Promise<RunState>;
};

export async function runDemo(request: StartRequest, recorder: RunStateRecorder): Promise<RunState> {
  const startedAt = Date.now();
  const agents = Array.from({ length: request.agents }, (_, index) => initialAgent(index + 1));
  let runState: RunState = {
    runId: request.runId,
    remote: request.remote,
    branch: request.branch,
    scenario: request.scenario,
    agents: request.agents,
    state: "running",
    startedAt,
    updatedAt: startedAt,
    agentStates: agents,
    desiredRepos: [],
    artifactFsEvents: [],
  };

  const update = async (agent: AgentState, next: Partial<AgentState>) => {
    Object.assign(agent, next, { updatedAt: Date.now() });
    runState = { ...runState, updatedAt: Date.now(), agentStates: agents };
    runState = await recorder.recordRunState(runState);
  };

  runState = await recorder.recordRunState(runState);
  await Promise.all(agents.map((agent) => runAgent(request, agent, update)));

  const failed = agents.some((agent) => agent.phase === "failed");
  runState = { ...runState, state: failed ? "failed" : "done", updatedAt: Date.now(), agentStates: agents };
  runState = await recorder.recordRunState(runState);
  return runState;
}

async function runAgent(
  request: StartRequest,
  agent: AgentState,
  update: (agent: AgentState, next: Partial<AgentState>) => Promise<void>,
): Promise<void> {
  try {
    await update(agent, { step: "waiting for desired repo mount" });
    await update(agent, { phase: "mounted", step: "waiting for mount" });
    await waitForMount(agent.repoName, agent.mountPath);
    await update(agent, { head: await gitHead(agent.mountPath), step: "mounted" });

    await update(agent, { phase: "running", step: "warming files" });
    await readMaybe(agent.mountPath, "README.md");
    await readMaybe(agent.mountPath, "package.json");
    await readMaybe(agent.mountPath, "go.mod");

    await update(agent, { phase: "dirty", step: "writing result" });
    const outputPath = path.join("demo-agent-output", `${agent.agentId}.md`);
    await writeText(agent.mountPath, outputPath, renderOutput(request, agent));

    await update(agent, { phase: "running", step: "committing result" });
    const commit = await gitCommit(agent.mountPath, `demo: ${agent.agentId} result`, outputPath);
    await update(agent, { phase: "done", step: "done", head: commit, commit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    await update(agent, { phase: "failed", step: "failed", error: message });
  }
}

function initialAgent(index: number): AgentState {
  const agentId = `agent-${index}`;
  return {
    agentId,
    repoName: agentId,
    mountPath: path.join(mountRoot, agentId),
    phase: "starting",
    step: "queued",
    head: null,
    commit: null,
    error: null,
    updatedAt: Date.now(),
  };
}

async function waitForMount(repoName: string, mountPath: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const status = await artifactStatus(repoName);
      if (status.includes("state=mounted") || status.includes("state=ready")) {
        await gitHead(mountPath);
        return;
      }
    } catch {
      // The daemon may not have picked up the repo registration yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`mount did not become ready for ${repoName}`);
}

function renderOutput(request: StartRequest, agent: AgentState): string {
  return [`# ${agent.agentId}`, "", `Run: ${request.runId}`, `Remote: ${request.remote}`, `Branch: ${request.branch}`].join("\n");
}
