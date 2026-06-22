# Rivet ArtifactFS sandbox

This directory runs ArtifactFS inside Cloudflare Sandbox with a small Bun/RivetKit process next to it.

The current flow is simple: start a sandbox, mount one repo per simulated agent, write one result file per agent, commit it, and show progress in a browser.

The directory is named `rivet-artifact-sanbox` because that was the requested path.

## Why this exists

ArtifactFS already handles the local filesystem work: Git access, FUSE, snapshots, overlays, and blob hydration.

The open question is what should sit beside that local filesystem when many agent workspaces are running at once. A sidecar actor runtime is one possible answer. This sandbox is a place to try that shape without changing ArtifactFS core code.

The actor boundaries below are candidates, not conclusions:

- `WorkspaceActor`: track one agent workspace from mount through commit.
- `HydrationWarmupActor`: store warmup hints for repos that agents open repeatedly.
- `ResultEventActor`: keep a small ledger of local result state, such as dirty, committed, pushed, reviewed, and cleaned up.

This sandbox currently exercises only the workspace piece. It does not benchmark Rivet, prove a production architecture, or say where actor calls belong in ArtifactFS internals.

## What runs

```text
Worker /demo/start
  -> Cloudflare Sandbox
    -> artifact-fs daemon
    -> Bun/RivetKit sidecar
      -> agent-1 mount + commit
      -> agent-2 mount + commit
      -> ...
Worker /demo/dashboard
  -> polls sidecar state through the sandbox
```

## Files

- `src/index.ts`: Worker with only `POST /demo/start`, `GET /demo/status`, and `GET /demo/dashboard`.
- `container_src/start.sh`: starts ArtifactFS and the sidecar, then kicks off a run.
- `container_src/demo-rivet`: Bun/RivetKit sidecar and tiny agent simulator.
- `Dockerfile`: builds ArtifactFS, installs Bun, and copies the sidecar.

## Local dev

```bash
cd examples/rivet-artifact-sanbox
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

Sidecar typecheck:

```bash
cd examples/rivet-artifact-sanbox/container_src/demo-rivet
bun install
bun run typecheck
```

## Start a run

```bash
curl -X POST http://localhost:8787/demo/start \
  -H 'authorization: Bearer local-dev-token' \
  -H 'content-type: application/json' \
  -d '{"sandboxId":"demo","agents":4}'
```

Dashboard:

```text
http://localhost:8787/demo/dashboard?sandboxId=demo&token=local-dev-token
```

Status JSON:

```bash
curl -H 'authorization: Bearer local-dev-token' \
  'http://localhost:8787/demo/status?sandboxId=demo'
```

## Deploy

```bash
cd examples/rivet-artifact-sanbox
bun run deploy
```

## Notes

- Use Bun only.
- This is not production auth, token management, cleanup, or scheduling.
- Private repos need auth wiring outside this sandbox.
- Any performance or architecture claims need separate tests. This directory does not make those claims.
