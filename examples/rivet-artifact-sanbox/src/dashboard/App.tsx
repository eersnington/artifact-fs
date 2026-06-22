import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Flow } from "@cloudflare/kumo/components/flow";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { createRunStateStore, type RunStateSnapshot } from "./run-state-store";
import {
  commitCount,
  formatDuration,
  formatTime,
  phaseBadgeVariant,
  shortSha,
  stageIndex,
  summarizeMilestoneEvents,
  type AgentPhase,
  type AgentState,
  type ArtifactFsEvent,
  type MilestoneEvent,
  type RunState,
} from "./model";

const params = new URLSearchParams(window.location.search);
const sandboxId = normalizeId(params.get("sandboxId") || "demo");
const token = params.get("token") || "";
const store = createRunStateStore({ sandboxId, token });

type WorkspaceBranch = {
  agentId: string;
  repoName: string;
  mountPath: string;
  phase: AgentPhase;
  step: string;
  commit: string | null;
  head: string | null;
  error: string | null;
  stage: number;
};

export function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return (
    <main className="dashboard-shell">
      <Header statusUrl={store.getStatusUrl()} state={snapshot.data} />
      <SystemStage snapshot={snapshot} />
      {snapshot.data ? <TechnicalTrace state={snapshot.data} /> : null}
    </main>
  );
}

function Header({ statusUrl, state }: { statusUrl: string; state: RunState | null }) {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_200);
  };

  return (
    <header className="dashboard-header">
      <div>
        <div className="dashboard-kicker">ArtifactFS sandbox</div>
        <Text as="h1" variant="heading1">Rivet + ArtifactFS</Text>
      </div>
      <div className="dashboard-header-actions">
        <Badge variant={state ? phaseBadgeVariant(state.state) : "neutral"} appearance="dot">
          {state?.state || "loading"}
        </Badge>
        <Button variant="secondary" icon={CopyIcon} onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
        <LinkButton variant="outline" icon={ArrowSquareOutIcon} href={statusUrl}>Raw JSON</LinkButton>
      </div>
    </header>
  );
}

function SystemStage({ snapshot }: { snapshot: RunStateSnapshot }) {
  return (
    <section className="system-stage" aria-label="Live workspace system map">
      <div className="system-stage-copy">
        <div>
          <Text as="h2" variant="heading1">Git workspaces for parallel agents</Text>
          <Text as="p" variant="secondary">Rivet coordinates desired workspaces. ArtifactFS mounts them as writable folders.</Text>
        </div>
        <div className="stage-legend" aria-label="Demo caveats">
          <span>simulated agents</span>
          <span>local commits only</span>
          <span>no GitHub push</span>
        </div>
      </div>

      <div className="system-frame">
        <SystemMap snapshot={snapshot} />
        <RunControlRail hasRun={Boolean(snapshot.data)} />
      </div>
    </section>
  );
}

function SystemMap({ snapshot }: { snapshot: RunStateSnapshot }) {
  const state = snapshot.data;
  const branches = workspaceBranches(state);
  const hasError = snapshot.status === "error";

  return (
    <div className="system-map">
      <SystemStatus snapshot={snapshot} />
      <Flow canvas={false} align="center" className="system-flow">
        <Flow.Node render={<SourceRepoNode state={state} />} />
        <Flow.Node render={<RivetControlNode state={state} />} />
        <Flow.Node render={<ArtifactFsDaemonNode state={state} />} />
        <Flow.Parallel align="start">
          {branches.map((branch) => (
            <Flow.Node key={branch.agentId} disabled={branch.phase === "starting" && !state} render={<WorkspaceLane branch={branch} />} />
          ))}
        </Flow.Parallel>
      </Flow>
      <StageTicks branches={branches} state={state} />
      {hasError ? <TechnicalStatusError message={snapshot.error} hasStaleData={Boolean(state)} /> : null}
    </div>
  );
}

function SystemStatus({ snapshot }: { snapshot: RunStateSnapshot }) {
  const state = snapshot.data;
  if (snapshot.status === "loading") {
    return (
      <div className="system-status neutral">
        <span>looking for sandbox state</span>
      </div>
    );
  }

  if (snapshot.status === "error") {
    return (
      <div className="system-status warning">
        <span>{state ? "reconnecting to sidecar" : "sidecar not ready"}</span>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="system-status neutral">
        <span>waiting for run</span>
      </div>
    );
  }

  return (
    <div className="system-status live">
      <span>{state.state === "done" ? "run complete" : "run live"}</span>
      <code>{state.runId}</code>
    </div>
  );
}

function SourceRepoNode({ state }: { state: RunState | null }) {
  return (
    <div className="system-node source-node">
      <span className="node-eyebrow">source</span>
      <strong>{repoLabel(state?.remote)}</strong>
      <span className="wire-label">branch {state?.branch || "main"}</span>
    </div>
  );
}

function RivetControlNode({ state }: { state: RunState | null }) {
  const desired = state?.desiredRepos?.length || state?.agentStates.length || state?.agents || 0;

  return (
    <div className="system-node rivet-node">
      <span className="node-eyebrow">Rivet</span>
      <strong>control plane</strong>
      <span className="node-count">{desired || 2} desired repos</span>
      <span className="wire-label">desired state</span>
    </div>
  );
}

function ArtifactFsDaemonNode({ state }: { state: RunState | null }) {
  const mounted = state?.agentStates.filter((agent) => stageIndex(agent) >= 1 || agent.phase === "done").length || 0;
  const total = state?.agentStates.length || state?.agents || 2;

  return (
    <div className="system-node artifactfs-node">
      <span className="node-eyebrow">ArtifactFS</span>
      <strong>daemon</strong>
      <span className="node-count">{mounted}/{total} mounted</span>
      <span className="wire-label">reconcile + mount</span>
    </div>
  );
}

function WorkspaceLane({ branch }: { branch: WorkspaceBranch }) {
  const hasCommit = Boolean(branch.commit);
  const isFailed = branch.phase === "failed";

  return (
    <div className={`workspace-lane ${branch.phase}`}>
      <div className="workspace-folder-tab">{branch.agentId}</div>
      <div className="workspace-lane-body">
        <div className="workspace-lane-topline">
          <code>{branch.mountPath}</code>
          <Badge variant={phaseBadgeVariant(branch.phase)} appearance="dot">{branch.phase}</Badge>
        </div>
        <div className="workspace-lane-path">
          <span className="worker-pill">agent worker</span>
          <span className="lane-connector" aria-hidden="true" />
          <span className={hasCommit ? "commit-pill complete" : isFailed ? "commit-pill failed" : "commit-pill pending"}>
            {hasCommit ? `commit ${shortSha(branch.commit)}` : isFailed ? "failed" : branch.step}
          </span>
        </div>
        {branch.error ? <Text as="p" variant="error" size="sm">{branch.error}</Text> : null}
      </div>
    </div>
  );
}

function StageTicks({ branches, state }: { branches: WorkspaceBranch[]; state: RunState | null }) {
  const labels = ["desired", "mounted", "hydrated", "written", "committed"];
  const total = branches.length;

  return (
    <div className="stage-ticks" aria-label="Run progress by stage">
      {labels.map((label, index) => {
        const complete = state ? branches.filter((branch) => branch.stage > index || branch.phase === "done").length : 0;
        return (
          <div className={complete === total && total > 0 ? "stage-tick complete" : complete > 0 ? "stage-tick active" : "stage-tick"} key={label}>
            <span>{label}</span>
            <strong>{complete}/{total}</strong>
          </div>
        );
      })}
    </div>
  );
}

function TechnicalStatusError({ message, hasStaleData }: { message: string; hasStaleData: boolean }) {
  return (
    <details className="technical-error inline-error">
      <summary>{hasStaleData ? "Showing stale data" : "Technical status error"}</summary>
      <Text as="p" variant="error">{message}</Text>
    </details>
  );
}

function RunControlRail({ hasRun }: { hasRun: boolean }) {
  const [newSandboxId, setNewSandboxId] = useState(defaultSandboxId);
  const [agents, setAgents] = useState("2");
  const [remote, setRemote] = useState("https://github.com/cloudflare/sandbox-sdk.git");
  const [branch, setBranch] = useState("main");
  const [status, setStatus] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const startRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("starting");
    setError(null);

    try {
      const response = await fetch("/demo/start", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sandboxId: newSandboxId,
          agents: Number(agents),
          remote: remote || undefined,
          branch: branch || undefined,
        }),
      });
      if (!response.ok) {
        throw new Error(await startResponseError(response));
      }
      const body = await response.json() as { sandboxId?: string };
      const nextSandboxId = normalizeId(body.sandboxId || newSandboxId);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("sandboxId", nextSandboxId);
      if (token) {
        nextUrl.searchParams.set("token", token);
      }
      window.location.assign(nextUrl.toString());
    } catch (startError) {
      setStatus("idle");
      setError(startError instanceof Error ? startError.message : "Failed to start the run.");
    }
  };

  return (
    <aside className="run-control-rail" aria-label="Run controls">
      <form className="rail-form" onSubmit={startRun}>
        <div className="rail-title">
          <div>
            <span>{hasRun ? "Next run" : "Start run"}</span>
            <strong>Control</strong>
          </div>
          <Badge variant={token ? "neutral" : "error"} appearance="dot">{token ? "ready" : "missing token"}</Badge>
        </div>
        <Input label="Sandbox" value={newSandboxId} onChange={(event) => setNewSandboxId(event.currentTarget.value)} />
        <Input label="Agents" type="number" min="1" max="8" value={agents} onChange={(event) => setAgents(event.currentTarget.value)} />
        <Input label="Remote" value={remote} onChange={(event) => setRemote(event.currentTarget.value)} />
        <Input label="Branch" value={branch} onChange={(event) => setBranch(event.currentTarget.value)} />
        <Button type="submit" variant="primary" loading={status === "starting"} disabled={!token || status === "starting"}>Start run</Button>
      </form>
      {error ? <Text as="p" variant="error" size="sm">{error}</Text> : null}
    </aside>
  );
}

function TechnicalTrace({ state }: { state: RunState }) {
  const elapsed = formatDuration((state.state === "running" ? Date.now() : state.updatedAt) - state.startedAt);

  return (
    <section className="technical-trace" aria-label="Technical run details">
      <LayerCard className="section-card trace-facts-card">
        <SectionTitle title="Run facts" />
        <dl className="facts-list trace-facts">
          <Fact label="Sandbox" value={sandboxId} />
          <Fact label="Run" value={state.runId} />
          <Fact label="Remote" value={state.remote} />
          <Fact label="Branch" value={state.branch} />
          <Fact label="Elapsed" value={elapsed} />
          <Fact label="Commits" value={String(commitCount(state))} />
          <Fact label="Updated" value={formatTime(state.updatedAt)} />
        </dl>
      </LayerCard>

      <LayerCard className="section-card table-card">
        <SectionTitle title="Local commits" />
        <CommitTable agents={state.agentStates} />
      </LayerCard>

      <LayerCard className="section-card table-card">
        <SectionTitle title="ArtifactFS evidence" />
        <EventTable events={state.artifactFsEvents || []} />
      </LayerCard>
    </section>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="section-title">
      <Text as="h2" variant="heading3">{title}</Text>
    </div>
  );
}

function CommitTable({ agents }: { agents: AgentState[] }) {
  const committedAgents = agents.filter((agent) => agent.commit);
  if (committedAgents.length === 0) {
    return <Empty title="No commits yet" description="Commits appear here as agents finish." size="sm" />;
  }

  return (
    <Table>
      <Table.Header variant="compact">
        <Table.Row>
          <Table.Head>Agent</Table.Head>
          <Table.Head>Repo</Table.Head>
          <Table.Head>Mount</Table.Head>
          <Table.Head>Commit</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {committedAgents.map((agent) => (
          <Table.Row key={agent.agentId}>
            <Table.Cell>{agent.agentId}</Table.Cell>
            <Table.Cell>{agent.repoName}</Table.Cell>
            <Table.Cell><code>{agent.mountPath}</code></Table.Cell>
            <Table.Cell><code>{shortSha(agent.commit)}</code></Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function EventTable({ events }: { events: ArtifactFsEvent[] }) {
  const milestones = summarizeMilestoneEvents(events);
  if (milestones.length === 0) {
    return <Empty title="No events yet" description="Runtime events appear here after the daemon records mount, hydration, status, or overlay changes." size="sm" />;
  }

  return (
    <Table>
      <Table.Header variant="compact">
        <Table.Row>
          <Table.Head>Kind</Table.Head>
          <Table.Head>Repo</Table.Head>
          <Table.Head>Evidence</Table.Head>
          <Table.Head>Count</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {milestones.map((event: MilestoneEvent) => (
          <Table.Row key={event.key}>
            <Table.Cell>{event.kind}</Table.Cell>
            <Table.Cell>{event.repo}</Table.Cell>
            <Table.Cell>{event.detail === "-" ? "-" : <code>{event.detail}</code>}</Table.Cell>
            <Table.Cell>{event.count}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function workspaceBranches(state: RunState | null): WorkspaceBranch[] {
  if (!state) {
    return ghostBranches(2);
  }
  if (state.agentStates.length === 0) {
    return ghostBranches(state.agents || 2);
  }
  return state.agentStates.map((agent) => ({
    agentId: agent.agentId,
    repoName: agent.repoName,
    mountPath: agent.mountPath,
    phase: agent.phase,
    step: agent.step,
    commit: agent.commit,
    head: agent.head,
    error: agent.error,
    stage: stageIndex(agent),
  }));
}

function ghostBranches(count: number): WorkspaceBranch[] {
  return Array.from({ length: Math.max(1, Math.min(count, 4)) }, (_, index) => {
    const id = `agent-${index + 1}`;
    return {
      agentId: id,
      repoName: id,
      mountPath: `/workspace/mnt/${id}`,
      phase: "starting",
      step: "waiting for run",
      commit: null,
      head: null,
      error: null,
      stage: 0,
    };
  });
}

function repoLabel(remote: string | null | undefined): string {
  if (!remote) {
    return "cloudflare/sandbox-sdk";
  }
  try {
    const url = new URL(remote);
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "") || remote;
  } catch {
    return remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  }
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63) || "demo";
}

function defaultSandboxId(): string {
  return `demo-run-${Math.floor(Date.now() / 1000)}`;
}

async function startResponseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") {
      return body.error;
    }
  }
  return await response.text();
}
