import { encodeBase64 } from "@oslojs/encoding";
import { CapsuleError } from "../core/errors.js";
import type { CommittedStep } from "../core/types.js";
import type { RepositorySession, RepositoryStore } from "./tree-backend.js";

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
export type RemoteHttpStoreOptions = {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
};

export function remoteHttpStore(options: RemoteHttpStoreOptions): RepositoryStore {
  const baseUrl = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  const sendRemoteRequest = async (
    method: "GET" | "POST",
    route: string,
    jsonBody?: unknown,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.token !== undefined
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
      });
    } catch (error) {
      throw new CapsuleError(
        "BACKEND_UNAVAILABLE",
        `Could not reach the remote artifact service at ${baseUrl} (${method} ${route}): ` +
          `${error instanceof Error ? error.message : String(error)}. No commit was made. ` +
          "Check the service URL and network access.",
        { cause: error },
      );
    }
    return response;
  };

  const assertRemoteResponseOk = async (
    response: Response,
    operation: string,
  ): Promise<void> => {
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    throw new CapsuleError(
      response.status >= 500 ? "BACKEND_UNAVAILABLE" : "BACKEND_WRITE_FAILED",
      `Remote artifact service rejected ${operation} with HTTP ${response.status}` +
        (text !== "" ? `: ${text.slice(0, 500)}` : ".") +
        " Committed history on the service is intact.",
    );
  };

  return {
    kind: "remote",

    async openRepository(repoName, init) {
      const response = await sendRemoteRequest("POST", "/runs/open", {
        repo: repoName,
        branch: init.branch,
        initFiles: encodeFileMap(init.initFiles),
        initMessage: init.initMessage,
      });
      await assertRemoteResponseOk(response, `open run repo "${repoName}"`);
      return createRemoteRepositorySession(repoName, init.branch);
    },
  };

  function createRemoteRepositorySession(
    repoName: string,
    branch: string,
  ): RepositorySession {
    const repoRoute = `/runs/${encodeURIComponent(repoName)}`;
    return {
      repo: repoName,
      branch,

      async readHead(): Promise<string | undefined> {
        const response = await sendRemoteRequest("GET", `${repoRoute}/head`);
        await assertRemoteResponseOk(response, "head lookup");
        const body = (await response.json()) as { head?: string };
        return body.head;
      },

      async readFile(path: string): Promise<Uint8Array | null> {
        const response = await sendRemoteRequest(
          "GET",
          `${repoRoute}/file?path=${encodeURIComponent(path)}`,
        );
        if (response.status === 404) return null;
        await assertRemoteResponseOk(response, `read ${path}`);
        return new Uint8Array(await response.arrayBuffer());
      },

      async commitFiles(input): Promise<CommittedStep> {
        const response = await sendRemoteRequest("POST", `${repoRoute}/commit`, {
          files: encodeFileMap(input.files),
          message: input.message,
        });
        await assertRemoteResponseOk(response, "commit");
        return (await response.json()) as CommittedStep;
      },
    };
  }
}

function encodeFileMap(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [path, bytes] of files) {
    encoded[path] = encodeBase64(bytes);
  }
  return encoded;
}
