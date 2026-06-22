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
  formatDuration,
  formatTime,
  phaseBadgeVariant,
  shortSha,
  stageCount,
  stages,
  type ArtifactFsEvent,
  type AgentState,
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
      <StartRunPanel />

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
        <Text as="h1" variant="heading1">Rivet ArtifactFS sandbox</Text>
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

function StartRunPanel() {
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
          <Text as="h2" variant="heading3">Start run</Text>
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
      <Text as="h2" variant="heading3">Loading run</Text>
    </LayerCard>
  );
}

function ErrorState({ message, staleState }: { message: string; staleState: RunState | null }) {
  return (
    <LayerCard className="dashboard-error-card">
      <Badge variant="error" appearance="dot">Status unavailable</Badge>
      <Text as="p" variant="error">{message}</Text>
      {staleState ? <Text as="p" variant="secondary">Showing stale data.</Text> : null}
    </LayerCard>
  );
}

function Dashboard({ state }: { state: RunState }) {
  const agents = state.agentStates;
  const done = agents.filter((agent) => agent.phase === "done").length;
  const failed = agents.filter((agent) => agent.phase === "failed").length;
  const commits = new Set(agents.flatMap((agent) => agent.commit ? [agent.commit] : [])).size;
  const elapsed = formatDuration((state.state === "running" ? Date.now() : state.updatedAt) - state.startedAt);

  return (
    <div className="dashboard-stack">
      <section className="summary-grid" aria-label="Run summary">
        <MetricCard label="Status" value={state.state} badge={state.state} detail={state.runId} />
        <MetricCard label="Agents" value={`${done}/${agents.length}`} detail={failed ? `${failed} failed` : agents.length - done === 0 ? "done" : `${agents.length - done} running`} />
        <MetricCard label="Commits" value={String(commits)} detail="commits" />
        <MetricCard label="Time" value={elapsed} detail={formatTime(state.updatedAt)} />
      </section>

      <section className="dashboard-grid">
        <LayerCard className="section-card">
          <SectionTitle title="Flow" />
          <div className="flow-scroll" aria-label="Run flow scroll area">
            <Flow canvas={false} align="center" className="run-flow">
              {stages.map((stage) => (
                <Flow.Node key={stage.key}>
                  <span className="flow-node-title">{stage.label}</span>
                  <span className="flow-node-count">{stageCount(stage, agents)}</span>
                </Flow.Node>
              ))}
            </Flow>
          </div>
        </LayerCard>

        <LayerCard className="section-card">
          <SectionTitle title="Run" />
          <dl className="facts-list">
            <Fact label="Sandbox" value={sandboxId} />
            <Fact label="Run" value={state.runId} />
            <Fact label="Remote" value={state.remote} />
            <Fact label="Branch" value={state.branch} />
          </dl>
        </LayerCard>
      </section>

      <LayerCard className="section-card">
        <SectionTitle title="Agents" />
        {agents.length ? <div className="agent-grid">{agents.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)}</div> : <Empty title="No agents yet" description="The sidecar has not published agent state for this run." size="sm" />}
      </LayerCard>

        <LayerCard className="section-card table-card">
          <SectionTitle title="Commits" />
          <CommitTable agents={agents} />
        </LayerCard>

        <LayerCard className="section-card table-card">
          <SectionTitle title="ArtifactFS events" />
          <EventTable events={state.artifactFsEvents || []} />
        </LayerCard>
      </div>
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

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="section-title">
      <Text as="h2" variant="heading3">{title}</Text>
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
  const recent = events.slice(-8).reverse();
  if (recent.length === 0) {
    return <Empty title="No events yet" description="Runtime events appear here after the daemon records mount, hydration, status, or overlay changes." size="sm" />;
  }

  return (
    <Table>
      <Table.Header variant="compact">
        <Table.Row>
          <Table.Head>Kind</Table.Head>
          <Table.Head>Repo</Table.Head>
          <Table.Head>Path</Table.Head>
          <Table.Head>State</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {recent.map((event, index) => (
          <Table.Row key={event.id || `${event.kind}-${event.repoId}-${index}`}>
            <Table.Cell>{event.kind}</Table.Cell>
            <Table.Cell>{event.repoName || event.repoId}</Table.Cell>
            <Table.Cell>{event.path ? <code>{event.path}</code> : "-"}</Table.Cell>
            <Table.Cell>{event.state || "-"}</Table.Cell>
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
