import { getSandbox } from "@cloudflare/sandbox";

export { Sandbox as RivetArtifactSandbox } from "@cloudflare/sandbox";

type Env = {
  RivetArtifactSandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  SANDBOX_API_TOKEN?: string;
};

type StartBody = {
  sandboxId?: string;
  remote?: string;
  branch?: string;
  agents?: number;
  scenario?: string;
};

const DEFAULT_REMOTE = "https://github.com/cloudflare/sandbox-sdk.git";
const DEFAULT_BRANCH = "main";
const DEFAULT_SANDBOX = "demo";
const START_SCRIPT = "/usr/local/bin/rivet-artifact-start";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return new Response("POST /demo/start\nGET /demo/status?sandboxId=demo\nGET /demo/dashboard?sandboxId=demo&token=local-dev-token\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/demo/start") {
        return startDemo(request, env);
      }

      if (request.method === "GET" && url.pathname === "/demo/status") {
        return demoStatus(request, env);
      }

      if (request.method === "GET" && url.pathname === "/demo/dashboard") {
        return dashboard(request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }
      const message = error instanceof Error ? error.message : "unknown error";
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function startDemo(request: Request, env: Env): Promise<Response> {
  authorize(request, env);
  const body = await parseBody(request);
  const sandboxId = normalizeId(body.sandboxId || DEFAULT_SANDBOX);
  const sandbox = getSandbox(env.RivetArtifactSandbox, sandboxId, { normalizeId: true, sleepAfter: "15m" });
  const agents = clamp(Number(body.agents || 2), 1, 8);

  const result = await sandbox.exec(START_SCRIPT, {
    cwd: "/workspace",
    timeout: 120_000,
    env: {
      DEMO_REMOTE: body.remote || DEFAULT_REMOTE,
      DEMO_BRANCH: body.branch || DEFAULT_BRANCH,
      DEMO_AGENTS: String(agents),
      DEMO_SCENARIO: body.scenario || "edit-and-commit",
    },
  });

  if (!result.success) {
    return Response.json({ error: result.stderr || result.stdout || "demo start failed" }, { status: 500 });
  }

  return Response.json({
    sandboxId,
    agents,
    output: result.stdout.trim(),
    dashboardUrl: `/demo/dashboard?sandboxId=${encodeURIComponent(sandboxId)}`,
  });
}

async function demoStatus(request: Request, env: Env): Promise<Response> {
  authorize(request, env);
  const sandbox = sandboxFromRequest(request, env);
  const result = await sandbox.exec("curl -fsS http://127.0.0.1:8788/state", { timeout: 15_000 });
  if (!result.success) {
    return Response.json({ error: result.stderr || "No demo state yet" }, { status: 404 });
  }
  return new Response(result.stdout, { headers: { "content-type": "application/json; charset=utf-8" } });
}

function dashboard(request: Request, env: Env): Response {
  authorize(request, env);
  const url = new URL(request.url);
  const sandboxId = normalizeId(url.searchParams.get("sandboxId") || DEFAULT_SANDBOX);
  return new Response(renderDashboard(sandboxId), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function sandboxFromRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const sandboxId = normalizeId(url.searchParams.get("sandboxId") || DEFAULT_SANDBOX);
  return getSandbox(env.RivetArtifactSandbox, sandboxId, { normalizeId: true, sleepAfter: "15m" });
}

async function parseBody(request: Request): Promise<StartBody> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as StartBody : {};
  } catch {
    return {};
  }
}

function authorize(request: Request, env: Env): void {
  const token = env.SANDBOX_API_TOKEN;
  if (!token) {
    return;
  }
  const url = new URL(request.url);
  const header = request.headers.get("authorization") || "";
  if (header === `Bearer ${token}` || url.searchParams.get("token") === token) {
    return;
  }
  throw new Response("Unauthorized", { status: 401 });
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63) || DEFAULT_SANDBOX;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function renderDashboard(sandboxId: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rivet ArtifactFS</title>
<style>
body{margin:0;font:14px ui-sans-serif,system-ui;background:#0b1020;color:#e8ecff}main{max-width:920px;margin:40px auto;padding:0 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.card{border:1px solid #26304f;border-radius:14px;background:#121a33;padding:14px}.muted{color:#95a0c8}.ok{color:#8ef0b3}.bad{color:#ff9b9b}code{color:#b7c4ff}</style>
<main>
<h1>Rivet ArtifactFS</h1>
<p class="muted">Sandbox <code>${sandboxId}</code></p>
<div id="state" class="muted">Loading...</div>
</main>
<script>
const sandboxId=${JSON.stringify(sandboxId)};
async function tick(){
  const res=await fetch('/demo/status?sandboxId='+encodeURIComponent(sandboxId)+'&token='+encodeURIComponent(new URLSearchParams(location.search).get('token')||''));
  const root=document.querySelector('#state');
  if(!res.ok){root.textContent=await res.text();return;}
  const state=await res.json();
  root.innerHTML='<p>Run <code>'+state.runId+'</code> is <strong class="'+(state.state==='failed'?'bad':'ok')+'">'+state.state+'</strong></p><div class="grid">'+state.agentStates.map(a=>'<section class="card"><strong>'+a.agentId+'</strong><p>'+a.phase+' · '+a.step+'</p><p class="muted">'+(a.commit||a.head||'no commit yet')+'</p>'+(a.error?'<p class="bad">'+a.error+'</p>':'')+'</section>').join('')+'</div>';
}
tick();setInterval(tick,2000);
</script>
</html>`;
}
