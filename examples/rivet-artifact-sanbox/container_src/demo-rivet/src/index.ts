import { readFile } from "node:fs/promises";
import { registry } from "./actors.js";
import { runDemo, type StartRequest } from "./simulate.js";

const port = Number(process.env.DEMO_PORT ?? 8788);
const demoDir = process.env.DEMO_DIR ?? "/tmp/rivet-artifact-demo";
void registry;

Bun.serve({
  port,
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/start") {
      const body = await request.json() as Partial<StartRequest>;
      const start = normalizeStart(body);
      void runDemo(start);
      return Response.json({ accepted: true, runId: start.runId, agents: start.agents });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      try {
        return new Response(await readFile(`${demoDir}/state.json`, "utf8"), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch {
        return Response.json({ error: "No demo state yet" }, { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

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
