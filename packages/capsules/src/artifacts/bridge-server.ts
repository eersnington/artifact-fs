import { decodeBase64 } from "@oslojs/encoding";
import { DEFAULT_BRANCH } from "../git/layout.js";
import { localNodeStore, type LocalNodeOptions } from "./local-node.js";

type EncodedFiles = Record<string, string>;

type OpenRunRequest = {
  readonly repo?: string;
  readonly branch?: string;
  readonly initFiles?: EncodedFiles;
  readonly initMessage?: string;
};

type CommitRequest = {
  readonly files?: EncodedFiles;
  readonly message?: string;
};

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
        const openRequest = (await request.json()) as OpenRunRequest;
        if (openRequest.repo === undefined) {
          return Response.json({ error: "Missing repo." }, { status: 400 });
        }
        const handle = await store.openRepo(openRequest.repo, {
          branch: openRequest.branch ?? DEFAULT_BRANCH,
          initFiles: decodeFiles(openRequest.initFiles ?? {}),
          initMessage: openRequest.initMessage ?? "capsule: init workflow run",
        });
        return Response.json({
          repo: handle.repo,
          branch: handle.branch,
          head: await handle.head(),
        });
      }

      const runMatch = /^\/runs\/([^/]+)\/(head|file|commit)$/.exec(
        url.pathname,
      );
      if (runMatch === null) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      const repoName = decodeURIComponent(runMatch[1]!);
      const action = runMatch[2]!;
      const handle = await store.openRepo(repoName, {
        branch: DEFAULT_BRANCH,
        initFiles: new Map(),
        initMessage: "capsule: init workflow run",
      });

      if (request.method === "GET" && action === "head") {
        return Response.json({ head: await handle.head() });
      }

      if (request.method === "GET" && action === "file") {
        const path = url.searchParams.get("path");
        if (path === null || path === "") {
          return Response.json({ error: "Missing path." }, { status: 400 });
        }
        const bytes = await handle.readFile(path);
        if (bytes === null) {
          return Response.json({ error: "File not found." }, { status: 404 });
        }
        return new Response(bytes);
      }

      if (request.method === "POST" && action === "commit") {
        const commitRequest = (await request.json()) as CommitRequest;
        if (commitRequest.message === undefined) {
          return Response.json({ error: "Missing message." }, { status: 400 });
        }
        const committed = await handle.commit({
          files: decodeFiles(commitRequest.files ?? {}),
          message: commitRequest.message,
        });
        return Response.json(committed);
      }

      return Response.json({ error: "Method not allowed." }, { status: 405 });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  };
}

function decodeFiles(files: EncodedFiles): Map<string, Uint8Array> {
  const decoded = new Map<string, Uint8Array>();
  for (const [path, encoded] of Object.entries(files)) {
    decoded.set(path, decodeBase64(encoded));
  }
  return decoded;
}
