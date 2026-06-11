type Env = {
  readonly ARTIFACTS: Artifacts;
  readonly INSPECTOR_TOKEN?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const configuredToken = env.INSPECTOR_TOKEN ?? "";
    if (configuredToken === "") {
      return Response.json({ error: "INSPECTOR_TOKEN is not configured" }, { status: 500 });
    }

    const authorization = request.headers.get("authorization") ?? "";
    if (authorization !== `Bearer ${configuredToken}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/repo") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const name = url.searchParams.get("name") ?? "";
    if (name === "") {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const repo = await env.ARTIFACTS.get(name);
    const token = await repo.createToken("read", 900);

    return Response.json({
      name: repo.name ?? name,
      remote: repo.remote,
      token: token.plaintext.split("?expires=")[0],
    });
  },
};
