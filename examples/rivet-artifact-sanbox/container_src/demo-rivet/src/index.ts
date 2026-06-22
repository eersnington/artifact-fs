import { createLocalWorkspace, registry } from "./actors.js";
import type { ArtifactFsEvent, CredentialRequest, WarmupRequest } from "./events.js";
import { runDemo, type StartRequest } from "./simulate.js";

const port = Number(process.env.DEMO_PORT ?? 8788);
const rivetBasePath = "/api/rivet";
const workspace = createLocalWorkspace();

Bun.serve({
  port,
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(`${rivetBasePath}/`)) {
      return registry.handler(request);
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/start") {
        const body = await parseJSON<Partial<StartRequest>>(request, {});
        const start = normalizeStart(body);
        await workspace.startRun(start);
        void runDemo(start, workspace).catch((error) => {
          console.error("demo run failed", error);
        });
        return Response.json({ accepted: true, runId: start.runId, agents: start.agents });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const state = await workspace.getRunState();
        if (!state) {
          return Response.json({ error: "No actor-backed demo state yet" }, { status: 404 });
        }
        return Response.json(state);
      }

      if (request.method === "GET" && url.pathname === "/v1/desired-repos") {
        return Response.json(await workspace.desiredRepos());
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const event = await parseJSON<ArtifactFsEvent | null>(request, null);
        if (!event) {
          return Response.json({ error: "event JSON body is required" }, { status: 400 });
        }
        await workspace.recordArtifactFsEvent(event);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && url.pathname === "/v1/warmup-plan") {
        const warmup = await parseJSON<WarmupRequest | null>(request, null);
        if (!warmup) {
          return Response.json({ error: "warmup request JSON body is required" }, { status: 400 });
        }
        return Response.json(await workspace.warmupPlan(warmup));
      }

      if (request.method === "POST" && url.pathname === "/v1/credential-env") {
        const credential = await parseJSON<CredentialRequest | null>(request, null);
        if (!credential) {
          return Response.json({ error: "credential request JSON body is required" }, { status: 400 });
        }
        return Response.json(await workspace.credentialEnv(credential));
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return Response.json({ error: message }, { status: 500 });
    }
  },
});

async function parseJSON<T>(request: Request, fallback: T): Promise<T> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as T : fallback;
  } catch {
    return fallback;
  }
}

function normalizeStart(body: Partial<StartRequest>): StartRequest {
  return {
    runId: body.runId || `run-${Date.now()}`,
    remote: body.remote || "https://github.com/cloudflare/sandbox-sdk.git",
    branch: body.branch || "main",
    agents: clamp(Number(body.agents || 2), 1, 8),
    scenario: body.scenario || "edit-and-commit",
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}
