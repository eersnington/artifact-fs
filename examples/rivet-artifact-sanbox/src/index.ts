import { getSandbox } from "@cloudflare/sandbox";

export { Sandbox as RivetArtifactSandbox } from "@cloudflare/sandbox";

type Env = {
  ASSETS: Fetcher;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return new Response("POST /demo/start\nGET /demo/status?sandboxId=demo\nGET /demo/dashboard?sandboxId=demo&token=local-dev-token\nSidecar exposes ArtifactFS /v1/desired-repos, /v1/events, /v1/warmup-plan, and /v1/credential-env inside the sandbox.\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/demo/start") {
        return startDemo(request, env, ctx);
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

async function startDemo(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  authorize(request, env);
  const body = await parseBody(request);
  const sandboxId = normalizeId(body.sandboxId || DEFAULT_SANDBOX);
  const sandbox = getSandbox(env.RivetArtifactSandbox, sandboxId, { normalizeId: true, sleepAfter: "15m" });
  const agents = clamp(Number(body.agents || 2), 1, 8);

  ctx.waitUntil(sandbox.exec(START_SCRIPT, {
    cwd: "/workspace",
    timeout: 120_000,
    env: {
      DEMO_REMOTE: body.remote || DEFAULT_REMOTE,
      DEMO_BRANCH: body.branch || DEFAULT_BRANCH,
      DEMO_AGENTS: String(agents),
      DEMO_SCENARIO: body.scenario || "edit-and-commit",
    },
  }).then((result) => {
    if (!result.success) {
      console.error("demo start failed", { sandboxId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    }
  }));

  return Response.json({
    accepted: true,
    sandboxId,
    agents,
    dashboardUrl: `/demo/dashboard?sandboxId=${encodeURIComponent(sandboxId)}`,
  });
}

async function demoStatus(request: Request, env: Env): Promise<Response> {
  authorize(request, env);
  const sandbox = sandboxFromRequest(request, env);
  const result = await withTimeout(
    sandbox.exec("curl -fsS http://127.0.0.1:8788/state", { timeout: 15_000 }),
    20_000,
    "Sandbox container is not ready yet. The status request timed out while waiting for sandbox.exec. Try again in a moment."
  );
  if (!result.success) {
    return Response.json({ error: result.stderr || "No actor-backed demo state yet" }, { status: 404 });
  }
  return new Response(result.stdout, { headers: { "content-type": "application/json; charset=utf-8" } });
}

function dashboard(request: Request, env: Env): Promise<Response> {
  authorize(request, env);
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/";
  assetUrl.search = "";
  return env.ASSETS.fetch(new Request(assetUrl, request));
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}
