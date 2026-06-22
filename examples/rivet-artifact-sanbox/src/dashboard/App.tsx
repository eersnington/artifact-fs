import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Flow } from "@cloudflare/kumo/components/flow";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { createRunStateStore } from "./run-state-store";
import {
  commitCount,
  formatDuration,
  formatTime,
  materializedWorkspaceCount,
  phaseBadgeVariant,
  shortSha,
  stageCount,
  stages,
  summarizeMilestoneEvents,
  type ArtifactFsEvent,
  type AgentState,
  type MilestoneEvent,
  type RunState,
} from "./model";

const params = new URLSearchParams(window.location.search);
const sandboxId = normalizeId(params.get("sandboxId") || "demo");
const token = params.get("token") || "";
const store = createRunStateStore({ sandboxId, token });

export function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return (
    <main className="dashboard-shell">
      <Header statusUrl={store.getStatusUrl()} state={snapshot.data} />
      <HeroExplainer state={snapshot.data} />
      <ProblemSolution />
      <ArchitectureDiagram state={snapshot.data} />
      <StartRunPanel hasRun={Boolean(snapshot.data)} />

      {snapshot.status === "loading" ? <LoadingState /> : null}
      {snapshot.status === "error" ? <ErrorState message={snapshot.error} staleState={snapshot.data} /> : null}
      {snapshot.data ? <Dashboard state={snapshot.data} /> : null}
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
        <Text as="h1" variant="heading1">Rivet + ArtifactFS workspace demo</Text>
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

function HeroExplainer({ state }: { state: RunState | null }) {
  const agents = state?.agentStates.length || state?.agents || 0;

  return (
    <section className="hero-panel" aria-label="What this demo shows">
      <div className="hero-copy">
        <Badge variant={state ? phaseBadgeVariant(state.state) : "neutral"} appearance="dot">
          {state ? `current run ${state.state}` : "ready to start"}
        </Badge>
        <Text as="h2" variant="heading1">Coordinate many Git workspaces without cloning the repo for every agent.</Text>
        <Text as="p" variant="secondary">
          Rivet decides which workspaces should exist. ArtifactFS materializes each one as a writable Git-backed folder. Agents then read, write, and commit independently inside those folders.
        </Text>
        <div className="concept-chips" aria-label="Component roles">
          <span><strong>Rivet</strong> desired state + event history</span>
          <span><strong>ArtifactFS</strong> Git-backed filesystem</span>
          <span><strong>Sandbox agents</strong> independent workers</span>
        </div>
      </div>
      <div className="hero-result-card">
        <span className="metric-label">Current proof</span>
        <strong>{state ? `${agents} workspaces` : "No run yet"}</strong>
        <span>{state ? `${commitCount(state)} local commits created from isolated mounted folders.` : "Start a run to boot the sandbox and materialize workspaces."}</span>
      </div>
    </section>
  );
}

function ProblemSolution() {
  return (
    <section className="explain-grid" aria-label="Problem and solution">
      <LayerCard className="explain-card problem-card">
        <span className="metric-label">The problem</span>
        <Text as="h2" variant="heading3">Multiple agents usually mean duplicated Git workspaces.</Text>
        <Text as="p" variant="secondary">Four agents on one repo often means four clones, duplicated blob downloads, repeated setup, and no durable coordinator tracking lifecycle.</Text>
      </LayerCard>
      <LayerCard className="explain-card solution-card">
        <span className="metric-label">The demo</span>
        <Text as="h2" variant="heading3">Rivet asks for workspaces; ArtifactFS mounts them.</Text>
        <Text as="p" variant="secondary">The sidecar publishes one desired workspace per agent. ArtifactFS reconciles that state into writable folders under <code>/workspace/mnt</code>.</Text>
      </LayerCard>
    </section>
  );
}

function ArchitectureDiagram({ state }: { state: RunState | null }) {
  const agents = state?.agentStates.length ? state.agentStates : [
    { agentId: "agent-1", repoName: "agent-1", mountPath: "/workspace/mnt/agent-1", phase: "starting", step: "queued", head: null, commit: null, error: null, updatedAt: 0 } satisfies AgentState,
    { agentId: "agent-2", repoName: "agent-2", mountPath: "/workspace/mnt/agent-2", phase: "starting", step: "queued", head: null, commit: null, error: null, updatedAt: 0 } satisfies AgentState,
  ];

  return (
    <LayerCard className="architecture-card">
      <div className="section-title">
        <Text as="h2" variant="heading3">What happens when you press Start</Text>
        <Text as="p" variant="secondary">The useful part is the handoff: Rivet coordinates desired workspaces, but ArtifactFS owns the local filesystem and Git behavior.</Text>
      </div>
      <div className="architecture-diagram" aria-label="Rivet and ArtifactFS architecture diagram">
        <DiagramNode eyebrow="Input" title="GitHub repo" detail={state?.remote || "cloudflare/sandbox-sdk"} />
        <DiagramArrow />
        <DiagramNode eyebrow="Coordinator" title="Rivet sidecar" detail="desired repos + events" />
        <DiagramArrow />
        <DiagramNode eyebrow="Filesystem" title="ArtifactFS daemon" detail="mounts writable Git trees" />
        <DiagramArrow />
        <div className="workspace-fanout">
          {agents.slice(0, 4).map((agent) => (
            <div className="workspace-node" key={agent.agentId}>
              <strong>{agent.agentId}</strong>
              <code>{agent.mountPath}</code>
              <span>{agent.commit ? `commit ${shortSha(agent.commit)}` : "waits for commit"}</span>
            </div>
          ))}
        </div>
      </div>
    </LayerCard>
  );
}

function DiagramNode({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="diagram-node">
      <span>{eyebrow}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DiagramArrow() {
  return <span className="diagram-arrow" aria-hidden="true">→</span>;
}

function StartRunPanel({ hasRun }: { hasRun: boolean }) {
  const [newSandboxId, setNewSandboxId] = useState(defaultSandboxId);
  const [agents, setAgents] = useState("4");
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
    <LayerCard className="start-card">
      <form className="start-form" onSubmit={startRun}>
        <div className="start-title">
          <div>
            <Text as="h2" variant="heading3">{hasRun ? "Start another run" : "Start a run"}</Text>
            <Text as="p" variant="secondary">Boot a sandbox, ask Rivet for one workspace per agent, and let ArtifactFS mount each workspace.</Text>
          </div>
          <Badge variant={token ? "neutral" : "error"} appearance="dot">{token ? "ready" : "missing token"}</Badge>
        </div>
        <Input label="Sandbox" value={newSandboxId} onChange={(event) => setNewSandboxId(event.currentTarget.value)} />
        <Input label="Agents" type="number" min="1" max="8" value={agents} onChange={(event) => setAgents(event.currentTarget.value)} />
        <Input label="Remote" value={remote} onChange={(event) => setRemote(event.currentTarget.value)} />
        <Input label="Branch" value={branch} onChange={(event) => setBranch(event.currentTarget.value)} />
        <Button type="submit" variant="primary" loading={status === "starting"} disabled={!token || status === "starting"}>Start</Button>
      </form>
      {error ? <Text as="p" variant="error" size="sm">{error}</Text> : null}
    </LayerCard>
  );
}

function LoadingState() {
  return (
    <LayerCard className="dashboard-empty-card">
      <Loader size="lg" aria-label="Loading sandbox state" />
      <Text as="h2" variant="heading3">Looking for an active sandbox run</Text>
      <Text as="p" variant="secondary">If this is the first visit, start a run to boot the sandbox container and launch the sidecar.</Text>
    </LayerCard>
  );
}

function ErrorState({ message, staleState }: { message: string; staleState: RunState | null }) {
  return (
    <LayerCard className="dashboard-error-card">
      <Badge variant="warning" appearance="dot">Sandbox not ready</Badge>
      <Text as="h2" variant="heading3">No active sidecar is answering yet.</Text>
      <Text as="p" variant="secondary">Start a run to boot the sandbox. If you just started one, the ArtifactFS sidecar usually appears after a short warmup.</Text>
      <details className="technical-error">
        <summary>Technical status error</summary>
        <Text as="p" variant="error">{message}</Text>
      </details>
      {staleState ? <Text as="p" variant="secondary">Showing stale data.</Text> : null}
    </LayerCard>
  );
}

function Dashboard({ state }: { state: RunState }) {
  const agents = state.agentStates;
  const done = agents.filter((agent) => agent.phase === "done").length;
  const failed = agents.filter((agent) => agent.phase === "failed").length;
  const commits = commitCount(state);
  const elapsed = formatDuration((state.state === "running" ? Date.now() : state.updatedAt) - state.startedAt);

  return (
    <div className="dashboard-stack">
      <section className="summary-grid" aria-label="Run summary">
        <MetricCard label="Demo result" value={state.state} badge={state.state} detail={state.runId} />
        <MetricCard label="Workspaces materialized" value={`${materializedWorkspaceCount(state)}/${agents.length}`} detail={failed ? `${failed} failed` : "writable folders under /workspace/mnt"} />
        <MetricCard label="Independent commits" value={String(commits)} detail="local sandbox commits, not GitHub pushes" />
        <MetricCard label="Elapsed time" value={elapsed} detail={formatTime(state.updatedAt)} />
      </section>

      <ProofCards state={state} />

      <section className="dashboard-grid">
        <LayerCard className="section-card">
          <SectionTitle title="Lifecycle" description="Each step shows how far the agents got through the workspace path." />
          <div className="flow-scroll" aria-label="Run flow scroll area">
            <Flow canvas={false} align="center" className="run-flow">
              {stages.map((stage) => (
                <Flow.Node key={stage.key}>
                  <span className="flow-node-title">{stage.label}</span>
                  <span className="flow-node-count">{stageCount(stage, agents)}</span>
                  <span className="flow-node-description">{stage.description}</span>
                </Flow.Node>
              ))}
            </Flow>
          </div>
        </LayerCard>

        <LayerCard className="section-card">
          <SectionTitle title="Current run" description="This is the run being summarized below. The form above starts a separate next run." />
          <dl className="facts-list">
            <Fact label="Sandbox" value={sandboxId} />
            <Fact label="Run" value={state.runId} />
            <Fact label="Remote" value={state.remote} />
            <Fact label="Branch" value={state.branch} />
          </dl>
        </LayerCard>
      </section>

      <LayerCard className="section-card">
        <SectionTitle title="Workspace proof" description="Each agent received its own ArtifactFS-mounted folder and committed inside it." />
        {agents.length ? <div className="agent-grid">{agents.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)}</div> : <Empty title="No agents yet" description="The sidecar has not published agent state for this run." size="sm" />}
      </LayerCard>

        <LayerCard className="section-card table-card">
          <SectionTitle title="Local commits" description="These hashes were created inside the sandbox working trees. Nothing was pushed to GitHub." />
          <CommitTable agents={agents} />
        </LayerCard>

        <LayerCard className="section-card table-card">
          <SectionTitle title="ArtifactFS evidence" description="Deduped daemon milestones. Raw JSON is available from the button above." />
          <EventTable events={state.artifactFsEvents || []} />
        </LayerCard>
      </div>
  );
}

function ProofCards({ state }: { state: RunState }) {
  const agents = state.agentStates;
  const commits = agents.filter((agent) => agent.commit);
  const desiredRepos = state.desiredRepos || [];

  return (
    <section className="proof-grid" aria-label="What this run proves">
      <LayerCard className="proof-card">
        <span className="metric-label">Proof 1</span>
        <Text as="h2" variant="heading3">Rivet coordinated workspace creation</Text>
        <Text as="p" variant="secondary">Desired state contains {desiredRepos.length || agents.length} workspace requests, one per agent.</Text>
      </LayerCard>
      <LayerCard className="proof-card">
        <span className="metric-label">Proof 2</span>
        <Text as="h2" variant="heading3">ArtifactFS materialized writable folders</Text>
        <Text as="p" variant="secondary">Mounted paths include {agents[0]?.mountPath ? <code>{agents[0].mountPath}</code> : "agent folders under /workspace/mnt"}.</Text>
      </LayerCard>
      <LayerCard className="proof-card">
        <span className="metric-label">Proof 3</span>
        <Text as="h2" variant="heading3">Agents produced independent commits</Text>
        <Text as="p" variant="secondary">{commits.length ? commits.map((agent) => shortSha(agent.commit)).join(" and ") : "Commits appear here when agents finish."}</Text>
      </LayerCard>
      <LayerCard className="proof-card caveat-card">
        <span className="metric-label">Not shown</span>
        <Text as="p" variant="secondary">This demo does not push to GitHub, create PRs, or run real AI agents. It proves the workspace coordination and filesystem path.</Text>
      </LayerCard>
    </section>
  );
}

function MetricCard({ label, value, detail, badge }: { label: string; value: string; detail: string; badge?: RunState["state"] }) {
  return (
    <LayerCard className="metric-card">
      <span className="metric-label">{label}</span>
      {badge ? <Badge variant={phaseBadgeVariant(badge)} appearance="dot">{value}</Badge> : <Text as="span" variant="heading2">{value}</Text>}
      <span className="metric-detail">{detail}</span>
    </LayerCard>
  );
}

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="section-title">
      <Text as="h2" variant="heading3">{title}</Text>
      {description ? <Text as="p" variant="secondary">{description}</Text> : null}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentState }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <span>{agent.agentId}</span>
        <Badge variant={phaseBadgeVariant(agent.phase)} appearance="dot">{agent.phase}</Badge>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <dl className="facts-list compact">
          <Fact label="Mount" value={agent.mountPath} />
          <Fact label="Commit" value={shortSha(agent.commit)} />
        </dl>
        {agent.error ? <Text as="p" variant="error" size="sm">{agent.error}</Text> : null}
      </LayerCard.Primary>
    </LayerCard>
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
          <Table.Head>Why it matters</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {milestones.map((event: MilestoneEvent) => (
          <Table.Row key={event.key}>
            <Table.Cell>{event.kind}{event.count > 1 ? ` ×${event.count}` : ""}</Table.Cell>
            <Table.Cell>{event.repo}</Table.Cell>
            <Table.Cell>{event.detail === "-" ? "-" : <code>{event.detail}</code>}</Table.Cell>
            <Table.Cell>{event.why}</Table.Cell>
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
