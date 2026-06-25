import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Text } from "@cloudflare/kumo/components/text";
import { Tooltip, TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import {
  ArrowSquareOutIcon,
  CloudArrowDownIcon,
  CopyIcon,
  FolderOpenIcon,
  GitCommitIcon,
  GithubLogoIcon,
  InfoIcon,
  PathIcon,
  PlayIcon,
  RobotIcon,
  StackIcon,
  TimerIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  commitCount,
  formatDuration,
  formatTime,
  shortSha,
  stageIndex,
  type AgentPhase,
  type AgentState,
  type ArtifactFsEvent,
  type DesiredRepo,
  type RunState,
} from "./model";
import { createRunStateStore, type RunStateSnapshot } from "./run-state-store";

const params = new URLSearchParams(window.location.search);
const sandboxId = normalizeId(params.get("sandboxId") || "demo");
const token = params.get("token") || "";
const store = createRunStateStore({ sandboxId, token });

type WorkbenchAgent = AgentState & {
  stage: number;
};

type StepStatus = "pending" | "active" | "done" | "failed";
type SignalTone = "blue" | "green" | "amber" | "purple" | "neutral" | "red";

type Benefit = {
  label: string;
  icon: Icon;
  detail: string;
};

type PipelineNode = {
  key: string;
  label: string;
  icon: Icon;
  value: string;
  status: StepStatus;
  detail: string;
};

const benefits: Benefit[] = [
  {
    label: "No full clone",
    icon: CloudArrowDownIcon,
    detail: "ArtifactFS exposes the repo as a folder while Git blobs hydrate only when needed.",
  },
  {
    label: "Local writes",
    icon: StackIcon,
    detail: "Agent output lands in ArtifactFS' local overlay before it becomes a commit.",
  },
  {
    label: "Normal folders",
    icon: FolderOpenIcon,
    detail: "The simulated agents use ordinary mounted paths, not a custom storage API.",
  },
  {
    label: "Local commits",
    icon: GitCommitIcon,
    detail: "The demo proves local Git commits inside mounted folders. It does not push or open PRs.",
  },
];

export function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const state = snapshot.data;
  const agents = workspaceAgents(state);
  const metrics = runMetrics(state, agents);

  return (
    <TooltipProvider>
      <main className="demo-shell">
        <Sidebar snapshot={snapshot} state={state} metrics={metrics} />
        <section className="demo-main" aria-label="ArtifactFS live observability">
          <MainHeader statusUrl={store.getStatusUrl()} snapshot={snapshot} state={state} metrics={metrics} />
          <BenefitStrip />
          <Pipeline snapshot={snapshot} state={state} metrics={metrics} />
          <MountActivity state={state} agents={agents} snapshot={snapshot} />
        </section>
      </main>
    </TooltipProvider>
  );
}

function Sidebar({ snapshot, state, metrics }: { snapshot: RunStateSnapshot; state: RunState | null; metrics: RunMetrics }) {
  return (
    <aside className="demo-rail" aria-label="Demo controls">
      <RailHeader snapshot={snapshot} />
      <RunControl hasRun={Boolean(state)} />
      <RunSnapshot snapshot={snapshot} state={state} metrics={metrics} />
    </aside>
  );
}

function RailHeader({ snapshot }: { snapshot: RunStateSnapshot }) {
  return (
    <div className="rail-header">
      <div className="rail-mark" aria-hidden="true">AFS</div>
      <div className="rail-title">
        <Text as="h1" variant="heading3">ArtifactFS</Text>
        <Text as="p" variant="secondary" size="sm">Rivet live demo</Text>
      </div>
      <Badge variant={snapshotBadgeVariant(snapshot)} appearance="dot">
        {snapshotLabel(snapshot)}
      </Badge>
    </div>
  );
}

function MainHeader({
  statusUrl,
  snapshot,
  state,
  metrics,
}: {
  statusUrl: string;
  snapshot: RunStateSnapshot;
  state: RunState | null;
  metrics: RunMetrics;
}) {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <header className="main-header">
      <div className="main-heading">
        <Text as="p" variant="secondary" size="sm">GitHub to Rivet to ArtifactFS to agents to commits</Text>
        <Text as="h2" variant="heading3">{state?.runId || sandboxId}</Text>
      </div>
      <div className="header-metrics" aria-label="Run summary">
        <HeaderMetric icon={GithubLogoIcon} label="Source" value={repoLabel(state?.remote)} />
        <HeaderMetric icon={FolderOpenIcon} label="Mounts" value={`${metrics.mounted}/${metrics.total}`} />
        <HeaderMetric icon={GitCommitIcon} label="Commits" value={`${metrics.committed}/${metrics.total}`} />
        <HeaderMetric icon={TimerIcon} label="Elapsed" value={metrics.elapsed} />
      </div>
      <div className="header-actions">
        {snapshot.status === "error" ? (
          <span className="quiet-warning">
            <WarningCircleIcon size={15} aria-hidden="true" />
            {snapshot.data ? "stale" : "offline"}
          </span>
        ) : null}
        <Button size="sm" variant="secondary" icon={CopyIcon} onClick={copyLink}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <LinkButton size="sm" variant="outline" icon={ArrowSquareOutIcon} href={statusUrl}>
          JSON
        </LinkButton>
      </div>
    </header>
  );
}

function HeaderMetric({ icon: IconComponent, label, value }: { icon: Icon; label: string; value: string }) {
  return (
    <div className="header-metric">
      <IconComponent size={15} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BenefitStrip() {
  return (
    <section className="benefit-strip" aria-label="ArtifactFS benefits">
      {benefits.map((benefit) => (
        <Tooltip
          key={benefit.label}
          content={benefit.detail}
          side="bottom"
          render={<button type="button" className="benefit-chip" />}
        >
          <benefit.icon size={15} aria-hidden="true" />
          <span>{benefit.label}</span>
        </Tooltip>
      ))}
    </section>
  );
}

function Pipeline({ snapshot, state, metrics }: { snapshot: RunStateSnapshot; state: RunState | null; metrics: RunMetrics }) {
  const nodes = pipelineNodes(snapshot, state, metrics);

  return (
    <section className="pipeline" aria-label="Live pipeline">
      {nodes.map((node, index) => (
        <Tooltip
          key={node.key}
          content={node.detail}
          side="bottom"
          render={<button type="button" className="pipeline-node" data-status={node.status} />}
        >
          <node.icon size={16} aria-hidden="true" />
          <span>{node.label}</span>
          <strong>{node.value}</strong>
          {index < nodes.length - 1 ? <i aria-hidden="true" /> : null}
        </Tooltip>
      ))}
    </section>
  );
}

function MountActivity({
  state,
  agents,
  snapshot,
}: {
  state: RunState | null;
  agents: WorkbenchAgent[];
  snapshot: RunStateSnapshot;
}) {
  const events = state?.artifactFsEvents || [];

  return (
    <section className="activity-section" aria-label="Live mount activity">
      <div className="activity-title">
        <div>
          <Text as="h2" variant="heading3">Mount Activity</Text>
          <Text as="p" variant="secondary" size="sm">{activitySubtitle(snapshot, state)}</Text>
        </div>
        <Badge variant={snapshotBadgeVariant(snapshot)} appearance="dot">
          {snapshotLabel(snapshot)}
        </Badge>
      </div>

      <div className="activity-scroll">
        <div className="mount-grid" role="table" aria-label="Mounted folders by agent">
          <div className="mount-head" role="row">
            <div role="columnheader">Source</div>
            <div role="columnheader">Rivet</div>
            <div role="columnheader">ArtifactFS</div>
            <div role="columnheader">Agents</div>
            <div role="columnheader">Commits</div>
            <div role="columnheader" aria-label="Details" />
          </div>
          {agents.map((agent) => (
            <AgentActivityRow
              key={agent.agentId}
              agent={agent}
              state={state}
              events={eventsForAgent(events, agent)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentActivityRow({
  agent,
  state,
  events,
}: {
  agent: WorkbenchAgent;
  state: RunState | null;
  events: ArtifactFsEvent[];
}) {
  const desired = isDesired(agent, state?.desiredRepos || []);
  const artifactLabel = artifactFsLabel(agent);
  const agentLabel = agentWorkLabel(agent);
  const commitLabel = agent.commit ? agent.commit.slice(0, 8) : "pending";
  const rivetLabel = desired ? "desired" : "pending";

  return (
    <div className="mount-row" role="row">
      <div className="lane-cell source-cell" role="cell">
        <StepPill
          icon={GithubLogoIcon}
          label={repoShortLabel(state?.remote)}
          status={state ? "done" : "pending"}
          detail={`Source repo on ${state?.branch || "main"}. ArtifactFS reads Git data lazily; this view does not claim a push back to GitHub.`}
        />
        <span className="subtle-line">{agent.repoName}</span>
      </div>
      <div className="lane-cell" role="cell">
        <StepPill
          icon={CloudArrowDownIcon}
          label={rivetLabel}
          status={desired ? "done" : state ? "active" : "pending"}
          detail="Rivet publishes desired workspace state. ArtifactFS decides how to materialize it locally."
        />
      </div>
      <div className="lane-cell artifact-cell" role="cell">
        <StepPill
          icon={PathIcon}
          label={artifactLabel}
          status={artifactFsStatus(agent)}
          detail="ArtifactFS owns the mounted folder, snapshot, overlay, gitdir, blob cache, hydration, and FUSE behavior."
        />
        <EventMarkers events={events} />
      </div>
      <div className="lane-cell" role="cell">
        <StepPill
          icon={RobotIcon}
          label={agentLabel}
          status={agentWorkStatus(agent)}
          detail={`Simulated agent step: ${agent.step}. The demo writes files through the mounted folder.`}
        />
      </div>
      <div className="lane-cell" role="cell">
        <StepPill
          icon={GitCommitIcon}
          label={commitLabel}
          status={commitStatus(agent)}
          detail="Git commit created inside the mounted folder. This is local Git state, not a GitHub push."
        />
      </div>
      <div className="details-cell" role="cell">
        <AgentDetails agent={agent} events={events} />
      </div>
    </div>
  );
}

function StepPill({
  icon: IconComponent,
  label,
  status,
  detail,
}: {
  icon: Icon;
  label: string;
  status: StepStatus;
  detail: string;
}) {
  return (
    <Tooltip content={detail} side="top" render={<button type="button" className="step-pill" data-status={status} />}>
      <IconComponent size={15} aria-hidden="true" />
      <span>{label}</span>
    </Tooltip>
  );
}

function EventMarkers({ events }: { events: ArtifactFsEvent[] }) {
  const visible = events.slice(-5);
  if (visible.length === 0) {
    return <span className="signal-empty">no signals</span>;
  }

  return (
    <div className="event-markers" aria-label="ArtifactFS runtime signals">
      {visible.map((event, index) => (
        <Tooltip
          key={`${event.kind}:${event.path || event.objectOid || event.generation || index}`}
          content={eventTooltip(event)}
          side="bottom"
          render={<button type="button" className="event-marker" data-tone={eventTone(event.kind)} />}
        >
          {eventShortLabel(event.kind)}
        </Tooltip>
      ))}
    </div>
  );
}

function AgentDetails({ agent, events }: { agent: WorkbenchAgent; events: ArtifactFsEvent[] }) {
  return (
    <Popover>
      <Popover.Trigger
        render={<button type="button" className="agent-info" aria-label={`Inspect ${agent.agentId}`} />}
      >
        <InfoIcon size={15} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content side="left" align="center" sideOffset={10} className="agent-popover">
        <Popover.Title>{agent.agentId}</Popover.Title>
        <Popover.Description>{agent.step}</Popover.Description>
        <dl className="popover-facts">
          <Fact label="Mount" value={agent.mountPath} />
          <Fact label="Phase" value={agent.phase} />
          <Fact label="Head" value={shortSha(agent.head)} />
          <Fact label="Commit" value={shortSha(agent.commit)} />
          {agent.error ? <Fact label="Error" value={agent.error} /> : null}
        </dl>
        <div className="popover-signals">
          {events.slice(-4).map((event, index) => (
            <span key={`${event.kind}:${event.path || event.generation || index}`} data-tone={eventTone(event.kind)}>
              {eventShortLabel(event.kind)}
            </span>
          ))}
          {events.length === 0 ? <span data-tone="neutral">none</span> : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}

function RunControl({ hasRun }: { hasRun: boolean }) {
  const [newSandboxId, setNewSandboxId] = useState(() => defaultSandboxId());
  const [agents, setAgents] = useState("3");
  const [branch, setBranch] = useState("main");
  const [remote, setRemote] = useState("");
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
    <section className="rail-section" aria-label="Start run">
      <div className="rail-section-title">
        <Text as="h2" variant="heading3">{hasRun ? "Next run" : "Start run"}</Text>
        <Badge variant={token ? "neutral" : "error"} appearance="dot">{token ? "ready" : "no token"}</Badge>
      </div>
      <form className="run-form" onSubmit={startRun}>
        <Input size="sm" label="Sandbox" value={newSandboxId} onChange={(event) => setNewSandboxId(event.currentTarget.value)} />
        <div className="form-grid">
          <Input size="sm" label="Agents" type="number" min="1" max="8" value={agents} onChange={(event) => setAgents(event.currentTarget.value)} />
          <Input size="sm" label="Branch" value={branch} onChange={(event) => setBranch(event.currentTarget.value)} />
        </div>
        <Input size="sm" label="Remote" value={remote} onChange={(event) => setRemote(event.currentTarget.value)} />
        <Button type="submit" size="sm" variant="primary" icon={PlayIcon} loading={status === "starting"} disabled={!token || status === "starting"}>
          Start
        </Button>
      </form>
      {error ? <Text as="p" variant="error" size="sm">{error}</Text> : null}
    </section>
  );
}

function RunSnapshot({
  snapshot,
  state,
  metrics,
}: {
  snapshot: RunStateSnapshot;
  state: RunState | null;
  metrics: RunMetrics;
}) {
  return (
    <section className="rail-section rail-facts" aria-label="Current run">
      <Text as="h2" variant="heading3">Run</Text>
      <dl>
        <Fact label="Sandbox" value={sandboxId} />
        <Fact label="Source" value={repoLabel(state?.remote)} />
        <Fact label="Branch" value={state?.branch || "main"} />
        <Fact label="Agents" value={`${metrics.total}`} />
        <Fact label="Elapsed" value={metrics.elapsed} />
        <Fact label="Updated" value={state ? formatTime(state.updatedAt) : snapshotLabel(snapshot)} />
      </dl>
    </section>
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

type RunMetrics = {
  total: number;
  desired: number;
  mounted: number;
  dirty: number;
  committed: number;
  elapsed: string;
};

function runMetrics(state: RunState | null, agents: WorkbenchAgent[]): RunMetrics {
  const total = Math.max(agents.length, state?.agents || 0, 1);
  const desired = state ? Math.max(state.desiredRepos?.length || 0, state.agentStates.length || state.agents || 0) : 0;
  const mounted = state ? agents.filter((agent) => agent.stage >= 1 || agent.phase === "done").length : 0;
  const dirty = state ? agents.filter((agent) => agent.phase === "dirty" || agent.stage >= 3).length : 0;
  const committed = state ? commitCount(state) : 0;
  const elapsed = state ? formatDuration((state.state === "running" ? Date.now() : state.updatedAt) - state.startedAt) : snapshotElapsedPlaceholder(agents);

  return { total, desired, mounted, dirty, committed, elapsed };
}

function pipelineNodes(snapshot: RunStateSnapshot, state: RunState | null, metrics: RunMetrics): PipelineNode[] {
  return [
    {
      key: "source",
      label: "Source",
      icon: GithubLogoIcon,
      value: repoShortLabel(state?.remote),
      status: state ? "done" : "pending",
      detail: "GitHub is the source remote. The demo observes local mount and commit behavior only.",
    },
    {
      key: "rivet",
      label: "Rivet",
      icon: CloudArrowDownIcon,
      value: `${metrics.desired || 0}/${metrics.total}`,
      status: countStatus(snapshot, metrics.total, metrics.desired),
      detail: "Rivet publishes desired workspaces and sidecar endpoints for events, warmup, and credential environment.",
    },
    {
      key: "artifactfs",
      label: "ArtifactFS",
      icon: PathIcon,
      value: `${metrics.mounted}/${metrics.total}`,
      status: countStatus(snapshot, metrics.total, metrics.mounted),
      detail: "ArtifactFS converges desired repos into writable mounted folders and remains local filesystem authority.",
    },
    {
      key: "agents",
      label: "Agents",
      icon: RobotIcon,
      value: `${metrics.dirty}/${metrics.total}`,
      status: countStatus(snapshot, metrics.total, metrics.dirty),
      detail: "Simulated agents read and write ordinary files through ArtifactFS mounts.",
    },
    {
      key: "commits",
      label: "Commits",
      icon: GitCommitIcon,
      value: `${metrics.committed}/${metrics.total}`,
      status: countStatus(snapshot, metrics.total, metrics.committed),
      detail: "Commits are created locally inside mounted folders. The demo does not push to GitHub.",
    },
  ];
}

function countStatus(snapshot: RunStateSnapshot, total: number, count: number): StepStatus {
  if (!snapshot.data) {
    return "pending";
  }
  if (snapshot.data.state === "failed" && count < total) {
    return "failed";
  }
  if (count >= total) {
    return "done";
  }
  return count > 0 || snapshot.data.state === "running" ? "active" : "pending";
}

function workspaceAgents(state: RunState | null): WorkbenchAgent[] {
  if (!state) {
    return ghostAgents(2);
  }
  if (state.agentStates.length === 0) {
    return ghostAgents(state.agents || 2);
  }
  return state.agentStates.map((agent) => ({
    ...agent,
    stage: stageIndex(agent),
  }));
}

function ghostAgents(count: number): WorkbenchAgent[] {
  return Array.from({ length: Math.max(1, Math.min(count, 4)) }, (_, index) => {
    const id = `agent-${index + 1}`;
    return {
      agentId: id,
      repoName: id,
      mountPath: `/workspace/mnt/${id}`,
      phase: "starting" as AgentPhase,
      step: "waiting",
      commit: null,
      head: null,
      error: null,
      updatedAt: 0,
      stage: 0,
    };
  });
}

function isDesired(agent: AgentState, desiredRepos: DesiredRepo[]): boolean {
  if (desiredRepos.length === 0) {
    return agent.phase !== "starting" || agent.step !== "waiting";
  }
  return desiredRepos.some((repo) => repo.name === agent.repoName || repo.id === agent.repoName || repo.name === agent.agentId);
}

function artifactFsLabel(agent: WorkbenchAgent): string {
  if (agent.phase === "failed") {
    return "failed";
  }
  if (agent.phase === "dirty" || agent.stage >= 3) {
    return "dirty";
  }
  if (agent.stage >= 2) {
    return "hydrated";
  }
  if (agent.stage >= 1 || agent.phase === "mounted") {
    return "mounted";
  }
  return "pending";
}

function agentWorkLabel(agent: WorkbenchAgent): string {
  if (agent.phase === "failed") {
    return "failed";
  }
  if (agent.phase === "done") {
    return "done";
  }
  if (agent.step.includes("writing")) {
    return "writing";
  }
  if (agent.step.includes("warming")) {
    return "reading";
  }
  if (agent.step.includes("committing")) {
    return "commit";
  }
  return agent.stage > 0 ? "active" : "waiting";
}

function artifactFsStatus(agent: WorkbenchAgent): StepStatus {
  if (agent.phase === "failed") {
    return "failed";
  }
  if (agent.phase === "done" || agent.stage >= 3) {
    return "done";
  }
  if (agent.stage >= 1) {
    return "active";
  }
  return "pending";
}

function agentWorkStatus(agent: WorkbenchAgent): StepStatus {
  if (agent.phase === "failed") {
    return "failed";
  }
  if (agent.phase === "done") {
    return "done";
  }
  if (agent.stage >= 2) {
    return "active";
  }
  return "pending";
}

function commitStatus(agent: WorkbenchAgent): StepStatus {
  if (agent.phase === "failed") {
    return "failed";
  }
  if (agent.commit || agent.phase === "done") {
    return "done";
  }
  if (agent.stage >= 4) {
    return "active";
  }
  return "pending";
}

function eventsForAgent(events: ArtifactFsEvent[], agent: AgentState): ArtifactFsEvent[] {
  return events.filter((event) => {
    const repo = event.repoName || event.repoId;
    return repo === agent.repoName || repo === agent.agentId || repo.endsWith(`/${agent.repoName}`);
  });
}

function eventShortLabel(kind: string): string {
  switch (kind) {
    case "repo.desired":
      return "desired";
    case "mount.attempted":
      return "mount";
    case "mount.ready":
      return "mounted";
    case "hydration.queued":
      return "warm";
    case "hydration.complete":
      return "hydrated";
    case "snapshot.published":
      return "snap";
    case "head.changed":
      return "head";
    case "fetch.succeeded":
      return "fetch";
    case "overlay.dirty":
      return "dirty";
    case "overlay.clean":
      return "clean";
    case "repo.disabled":
      return "off";
    default:
      return kind.replace(/^.*\./, "").slice(0, 9);
  }
}

function eventTone(kind: string): SignalTone {
  if (kind.includes("hydration")) {
    return "purple";
  }
  if (kind.includes("dirty") || kind.includes("queued")) {
    return "amber";
  }
  if (kind.includes("ready") || kind.includes("clean") || kind.includes("succeeded")) {
    return "green";
  }
  if (kind.includes("disabled")) {
    return "red";
  }
  if (kind.includes("desired") || kind.includes("snapshot") || kind.includes("head")) {
    return "blue";
  }
  return "neutral";
}

function eventTooltip(event: ArtifactFsEvent): string {
  const detail = event.path || event.objectOid || event.state || (event.generation ? `generation ${event.generation}` : "");
  return detail ? `${event.kind}: ${detail}` : event.kind;
}

function activitySubtitle(snapshot: RunStateSnapshot, state: RunState | null): string {
  if (state) {
    return `${state.agentStates.length || state.agents} mounted folders observed from live run state`;
  }
  if (snapshot.status === "error") {
    return "waiting for live JSON from /demo/status";
  }
  return "connecting to live run state";
}

function snapshotElapsedPlaceholder(agents: WorkbenchAgent[]): string {
  return agents.some((agent) => agent.stage > 0) ? "running" : "waiting";
}

function snapshotBadgeVariant(snapshot: RunStateSnapshot): "success" | "warning" | "error" | "neutral" {
  if (snapshot.status === "error") {
    return snapshot.data ? "warning" : "error";
  }
  if (!snapshot.data) {
    return "neutral";
  }
  if (snapshot.data.state === "done") {
    return "success";
  }
  if (snapshot.data.state === "failed") {
    return "error";
  }
  return "warning";
}

function snapshotLabel(snapshot: RunStateSnapshot): string {
  if (snapshot.status === "loading") {
    return "connecting";
  }
  if (snapshot.status === "error") {
    return snapshot.data ? "stale" : "offline";
  }
  return snapshot.data.state;
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

function repoShortLabel(remote: string | null | undefined): string {
  const label = repoLabel(remote);
  return label.split("/").filter(Boolean).pop() || label;
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
