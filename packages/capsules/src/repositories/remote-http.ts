import { CapsuleError } from "../core/errors.js";
import type { CallStore, CallStoreRun, CommitResult } from "../core/types.js";

/**
 * HTTP call-history store shared by remote HTTP-backed adapters. The service
 * owns the Git repos and implements this protocol:
 *
 *   POST /runs/open                multipart metadata + raw file parts      -> { repo, branch, head? }
 *   GET  /runs/:repo/head                                                  -> { head? }
 *   GET  /runs/:repo/file?path=<p>                                         -> 200 bytes | 404
 *   POST /runs/:repo/commit        multipart metadata + raw file parts      -> { commit, parent? }
 *
 * Multipart requests contain a `metadata` JSON part whose file entries map
 * repo paths to form part names; repo paths never come from multipart filenames.
 * File bodies are still buffered before `fetch()`, so this adapter is not for
 * very large commits.
 */
export type RemoteHttpStoreOptions = {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
};

type MultipartFileEntry = {
  readonly path: string;
  readonly part: string;
};

type OpenRepositoryMetadata = {
  readonly protocolVersion: 1;
  readonly repo: string;
  readonly branch: string;
  readonly message: string;
  readonly files: readonly MultipartFileEntry[];
};

type CommitFilesMetadata = {
  readonly protocolVersion: 1;
  readonly message: string;
  readonly files: readonly MultipartFileEntry[];
};

export function remoteHttpStore(options: RemoteHttpStoreOptions): CallStore {
  const baseUrl = options.url.replace(/\/+$/, "");
  const fetchRemote = options.fetch ?? fetch;

  const sendRemoteRequest = async (
    method: "GET" | "POST",
    route: string,
    body?: FormData,
  ): Promise<Response> => {
    let response: Response;
    try {
      const requestOptions: NonNullable<Parameters<typeof fetch>[1]> = { method };
      if (options.token !== undefined) {
        requestOptions.headers = { authorization: `Bearer ${options.token}` };
      }
      if (body !== undefined) {
        requestOptions.body = body;
      }
      response = await fetchRemote(`${baseUrl}${route}`, requestOptions);
    } catch (error) {
      throw new CapsuleError(
        "SIDE_EFFECT_STORAGE_FAILED",
        `Could not reach the remote call-history service at ${baseUrl} (${method} ${route}): ` +
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
      "SIDE_EFFECT_STORAGE_FAILED",
      `Remote call-history service rejected ${operation} with HTTP ${response.status}` +
        (text !== "" ? `: ${text.slice(0, 500)}` : ".") +
        " Committed history on the service is intact.",
    );
  };

  return {
    kind: "remote",

    async openRun(input) {
      const response = await sendRemoteRequest("POST", "/runs/open", buildMultipartBody({
        protocolVersion: 1,
        repo: input.repoName,
        branch: input.branch,
        message: input.initMessage,
        files: fileEntries(input.initFiles),
      }, input.initFiles));
      await assertRemoteResponseOk(response, `open run repo "${input.repoName}"`);
      return createRemoteRun(input.repoName, input.branch);
    },
  };

  function createRemoteRun(
    repoName: string,
    branch: string,
  ): CallStoreRun {
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

      async commitFiles(commit): Promise<CommitResult> {
        const response = await sendRemoteRequest("POST", `${repoRoute}/commit`, buildMultipartBody({
          protocolVersion: 1,
          message: commit.message,
          files: fileEntries(commit.files),
        }, commit.files));
        await assertRemoteResponseOk(response, "commit");
        return (await response.json()) as CommitResult;
      },
    };
  }
}

function buildMultipartBody(
  metadata: OpenRepositoryMetadata | CommitFilesMetadata,
  files: ReadonlyMap<string, Uint8Array>,
): FormData {
  const remoteMultipartBody = new FormData();
  remoteMultipartBody.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  for (const { path, part } of metadata.files) {
    const bytes = files.get(path);
    if (bytes === undefined) {
      throw new CapsuleError(
        "INVALID_EXTERNAL_CALL",
        `Remote multipart request metadata referenced ${path}, but no bytes were staged for that path. ` +
          `No request was sent; retry after rebuilding the staged file set.`,
      );
    }
    remoteMultipartBody.set(part, new Blob([bytes]), part);
  }
  return remoteMultipartBody;
}

function fileEntries(files: ReadonlyMap<string, Uint8Array>): MultipartFileEntry[] {
  let index = 0;
  const entries: MultipartFileEntry[] = [];
  for (const path of files.keys()) {
    entries.push({ path, part: `file-${index}` });
    index += 1;
  }
  return entries;
}
