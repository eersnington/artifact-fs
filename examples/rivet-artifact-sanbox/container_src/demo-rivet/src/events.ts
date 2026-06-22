import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const demoDir = process.env.DEMO_DIR ?? "/tmp/rivet-artifact-demo";

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

export async function writeState(state: RunState): Promise<void> {
  await mkdir(demoDir, { recursive: true });
  const tmp = path.join(demoDir, `state.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path.join(demoDir, "state.json"));
}
