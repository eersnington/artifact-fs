# Rivet ArtifactFS sandbox

This directory runs ArtifactFS inside Cloudflare Sandbox with a small Bun/RivetKit control-plane process next to it.

The current flow is simple: start a sandbox, mount one repo per simulated agent, write one result file per agent, commit it, and show progress in a browser.

The directory is named `rivet-artifact-sanbox` because that was the requested path.

## Why this exists

ArtifactFS already handles the local filesystem work: Git access, FUSE, snapshots, overlays, and blob hydration.

The sidecar is the Rivet HTTP coordinator for ArtifactFS. ArtifactFS still owns Git access, FUSE, snapshots, overlays, and blob hydration locally; the actor owns desired repo state, runtime event history, warmup hints, and dashboard state.

The actor boundaries below are intentionally small:

- `WorkspaceActor`: track desired repos, agent progress, ArtifactFS runtime events, and warmup hints.

This sandbox does not benchmark Rivet or prove a production architecture. It demonstrates the core adapter path without putting actors on FUSE read/write hot paths.

## What runs

```text
Worker /demo/start
  -> Cloudflare Sandbox
    -> Bun/RivetKit sidecar exposes /v1/* control-plane endpoints
    -> artifact-fs daemon --controlplane rivet --rivet-url http://127.0.0.1:8788
      -> reconciles actor desired repos
      -> records runtime events back to actor
    -> agents wait for mounts and commit through ArtifactFS
      -> ...
Worker /demo/dashboard
  -> polls actor-backed sidecar state through the sandbox
```

## Files

- `src/index.ts`: Worker with only `POST /demo/start`, `GET /demo/status`, and `GET /demo/dashboard`.
- `container_src/start.sh`: starts ArtifactFS and the sidecar, then kicks off a run.
- `container_src/demo-rivet`: Bun/RivetKit control-plane sidecar and tiny agent simulator.
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
- Private repos need a real `/v1/credential-env` secret provider. The demo endpoint only supports public remotes.
- Any performance or architecture claims need separate tests. This directory does not make those claims.
