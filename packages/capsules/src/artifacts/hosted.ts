import { encodeBase64 } from "@oslojs/encoding";
import { CapsuleError } from "../core/errors.js";
import type { CommittedStep } from "../core/types.js";
import type { RepoHandle, TreeStore } from "./tree-backend.js";

/**
 * HTTP artifact store shared by remote HTTP-backed adapters. The service owns
 * the Git repos (for example an ArtifactFS mount plus native git, or a hosted
 * artifact API) and implements this protocol:
 *
 *   POST /runs/open                { repo, branch, initFiles, initMessage } -> { repo, branch, head? }
 *   GET  /runs/:repo/head                                                  -> { head? }
 *   GET  /runs/:repo/file?path=<p>                                         -> 200 bytes | 404
 *   POST /runs/:repo/commit        { files, message }                      -> { commit, parent? }
 *
 * File bytes are base64-encoded into JSON objects keyed by repo path, for
 * example `{ files: { "steps/.../output.txt": "aGVsbG8=" } }`. The full JSON
 * request is built in memory before `fetch()`, so this adapter is not for very
 * large commits.
 */
export type HttpStoreOptions = {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
};

export function httpStore(options: HttpStoreOptions): TreeStore {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.token !== undefined
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CapsuleError(
        "BACKEND_UNAVAILABLE",
        `Could not reach the remote artifact service at ${base} (${method} ${path}): ` +
          `${error instanceof Error ? error.message : String(error)}. No commit was made. ` +
          "Check the service URL and network access.",
        { cause: error },
      );
    }
    return response;
  };

  const requireOk = async (response: Response, what: string): Promise<void> => {
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    throw new CapsuleError(
      response.status >= 500 ? "BACKEND_UNAVAILABLE" : "BACKEND_WRITE_FAILED",
      `Remote artifact service rejected ${what} with HTTP ${response.status}` +
        (text !== "" ? `: ${text.slice(0, 500)}` : ".") +
        " Committed history on the service is intact.",
    );
  };

  return {
    kind: "remote",

    async openRepo(name, init) {
      const response = await request("POST", "/runs/open", {
        repo: name,
        branch: init.branch,
        initFiles: encodeFiles(init.initFiles),
        initMessage: init.initMessage,
      });
      await requireOk(response, `open of run repo "${name}"`);
      return handleFor(name, init.branch);
    },
  };

  function handleFor(name: string, branch: string): RepoHandle {
    const repoPath = `/runs/${encodeURIComponent(name)}`;
    return {
      repo: name,
      branch,

      async head(): Promise<string | undefined> {
        const response = await request("GET", `${repoPath}/head`);
        await requireOk(response, "head lookup");
        const body = (await response.json()) as { head?: string };
        return body.head;
      },

      async readFile(path: string): Promise<Uint8Array | null> {
        const response = await request(
          "GET",
          `${repoPath}/file?path=${encodeURIComponent(path)}`,
        );
        if (response.status === 404) return null;
        await requireOk(response, `read of ${path}`);
        return new Uint8Array(await response.arrayBuffer());
      },

      async commit(input): Promise<CommittedStep> {
        const response = await request("POST", `${repoPath}/commit`, {
          files: encodeFiles(input.files),
          message: input.message,
        });
        await requireOk(response, "commit");
        return (await response.json()) as CommittedStep;
      },
    };
  }
}

function encodeFiles(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [path, bytes] of files) {
    encoded[path] = encodeBase64(bytes);
  }
  return encoded;
}
