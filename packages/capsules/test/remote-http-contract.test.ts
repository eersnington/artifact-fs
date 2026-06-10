import { describe, expect, it } from "vitest";
import { createCapsules } from "../src/index.js";
import { remote } from "../src/remote.js";

describe("remote HTTP adapter", () => {
  it("sends multipart metadata with raw file parts", async () => {
    const requests: Array<{
      readonly method: string;
      readonly path: string;
      readonly authorization: string | null;
      readonly body: FormData | undefined;
    }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body instanceof FormData ? init.body : undefined;
      requests.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });

      if (url.pathname === "/runs/open") {
        return jsonResponse({ repo: "repo", branch: "main", head: "0".repeat(40) });
      }
      if (url.pathname.endsWith("/head")) {
        return jsonResponse({ head: "0".repeat(40) });
      }
      if (url.pathname.endsWith("/file")) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/commit")) {
        return jsonResponse({ commit: "1".repeat(40), parent: "0".repeat(40) });
      }
      return new Response("unexpected route", { status: 500 });
    };
    const capsules = createCapsules({
      adapter: remote({
        url: "https://remote.example",
        token: "secret-token",
        fetch: fakeFetch,
      }),
    });

    const refs = await capsules.capture({
      workflow: { workflowName: "BinaryWorkflow", instanceId: "binary-1" },
      step: { step: { name: "capture binary", count: 1 }, attempt: 1 },
      name: "binary-capsule",
      input: { id: "raw" },
      run: async ({ files }) => {
        await files.write("binary/raw.bin", new Uint8Array([0, 255, 1, 2]), {
          exposeAs: "raw",
        });
        return { ok: true };
      },
    });

    const openRequest = requests.find((request) => request.path === "/runs/open");
    expect(openRequest?.authorization).toBe("Bearer secret-token");
    const openMetadata = await readMetadata(openRequest?.body);
    expect(openMetadata).toMatchObject({
      protocolVersion: 1,
      branch: "main",
      message: "capsule: init workflow run",
    });
    expect(openMetadata.files).toEqual([
      { path: ".capsule/run.json", part: "file-0" },
    ]);
    await expect(readPart(openRequest?.body, "file-0")).resolves.toContain(
      "BinaryWorkflow",
    );

    const commitRequest = requests.find((request) => request.path.endsWith("/commit"));
    expect(commitRequest?.authorization).toBe("Bearer secret-token");
    const commitMetadata = await readMetadata(commitRequest?.body);
    expect(commitMetadata).toMatchObject({
      protocolVersion: 1,
      message: "capsule: binary-capsule step 001-capture-binary attempt 1",
    });
    expect(JSON.stringify(commitMetadata)).not.toContain("AP8BAg");
    const rawEntry = commitMetadata.files.find(
      (entry: { path: string }) => entry.path === refs.files.raw!.path,
    );
    expect(rawEntry).toBeDefined();
    await expect(readPartBytes(commitRequest?.body, rawEntry!.part)).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function readMetadata(body: FormData | undefined): Promise<{
  readonly files: Array<{ readonly path: string; readonly part: string }>;
  readonly [key: string]: unknown;
}> {
  const metadata = body?.get("metadata");
  if (!(metadata instanceof Blob)) {
    throw new Error("missing metadata part");
  }
  return JSON.parse(await metadata.text()) as {
    readonly files: Array<{ readonly path: string; readonly part: string }>;
    readonly [key: string]: unknown;
  };
}

async function readPart(body: FormData | undefined, part: string): Promise<string> {
  return new TextDecoder().decode(await readPartBytes(body, part));
}

async function readPartBytes(
  body: FormData | undefined,
  part: string,
): Promise<Uint8Array> {
  const file = body?.get(part);
  if (!(file instanceof Blob)) {
    throw new Error(`missing ${part} part`);
  }
  return new Uint8Array(await file.arrayBuffer());
}
