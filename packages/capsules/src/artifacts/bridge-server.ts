import { DEFAULT_BRANCH } from "../git/layout.js";
import { localNodeStore, type LocalNodeOptions } from "./local-node.js";

/**
 * Framework-neutral local bridge handler. Run this in a local Node service
 * (or any runtime with Fetch API Request/Response) and point Workers code at
 * it with `Artifacts.localBridge({ url })`.
 *
 * The bridge owns local Git repos under `mountRoot`; ArtifactFS can mount or
 * inspect the same root outside the Worker runtime.
 */
export function createLocalBridgeHandler(options: LocalNodeOptions) {
  const store = localNodeStore(options);

  return async function handleLocalBridge(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/runs/open") {
        const body = (await request.json()) as {
          repo?: string;
          branch?: string;
          initFiles?: Record<string, string>;
          initMessage?: string;
        };
        if (body.repo === undefined) {
          return json({ error: "Missing repo." }, 400);
        }
        const handle = await store.openRepo(body.repo, {
          branch: body.branch ?? DEFAULT_BRANCH,
          initFiles: decodeFiles(body.initFiles ?? {}),
          initMessage: body.initMessage ?? "capsule: init workflow run",
        });
        return json({
          repo: handle.repo,
          branch: handle.branch,
          head: await handle.head(),
        });
      }

      const runMatch = /^\/runs\/([^/]+)\/(head|file|commit)$/.exec(
        url.pathname,
      );
      if (runMatch === null) {
        return json({ error: "Not found." }, 404);
      }
      const repo = decodeURIComponent(runMatch[1]!);
      const action = runMatch[2]!;
      const handle = await store.openRepo(repo, {
        branch: DEFAULT_BRANCH,
        initFiles: new Map(),
        initMessage: "capsule: init workflow run",
      });

      if (request.method === "GET" && action === "head") {
        return json({ head: await handle.head() });
      }

      if (request.method === "GET" && action === "file") {
        const path = url.searchParams.get("path");
        if (path === null || path === "") {
          return json({ error: "Missing path." }, 400);
        }
        const bytes = await handle.readFile(path);
        if (bytes === null) return json({ error: "File not found." }, 404);
        return new Response(bytes);
      }

      if (request.method === "POST" && action === "commit") {
        const body = (await request.json()) as {
          files?: Record<string, string>;
          message?: string;
        };
        if (body.message === undefined) {
          return json({ error: "Missing message." }, 400);
        }
        const committed = await handle.commit({
          files: decodeFiles(body.files ?? {}),
          message: body.message,
        });
        return json(committed);
      }

      return json({ error: "Method not allowed." }, 405);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function decodeFiles(files: Record<string, string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [path, base64] of Object.entries(files)) {
    out.set(path, fromBase64(base64));
  }
  return out;
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
