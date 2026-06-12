import { describe, expect, it } from "vitest";
import { createStepdaddy, defineExternalCall } from "../src/index.js";
import { remote } from "../src/remote.js";

describe("remote HTTP adapter", () => {
  it("sends multipart metadata with raw call-history record parts", async () => {
    const requests: Array<{
      readonly method: string;
      readonly path: string;
      readonly authorization: string | null;
      readonly body: FormData | undefined;
    }> = [];
    const files = new Map<string, Uint8Array>();
    let head = "0".repeat(40);
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
        await storeParts(body, files);
        return jsonResponse({ repo: "repo", branch: "main", head });
      }
      if (url.pathname.endsWith("/head")) {
        return jsonResponse({ head });
      }
      if (url.pathname.endsWith("/file")) {
        const path = url.searchParams.get("path") ?? "";
        const bytes = files.get(path);
        return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes);
      }
      if (url.pathname.endsWith("/commit")) {
        await storeParts(body, files);
        const parent = head;
        head = head === "0".repeat(40) ? "1".repeat(40) : "2".repeat(40);
        return jsonResponse({ commit: head, parent });
      }
      return new Response("unexpected route", { status: 500 });
    };
    const stepdaddy = createStepdaddy({
      adapter: remote({
        url: "https://remote.example",
        token: "secret-token",
        fetch: fakeFetch,
      }),
    });
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute: async () => ({ id: "pi_123" }),
    });

    const result = await stepdaddy.call(call, {
      workflow: { workflowName: "BinaryWorkflow", instanceId: "binary-1" },
      step: { step: { name: "charge customer", count: 1 }, attempt: 1 },
      key: "wf:binary-1:charge-customer",
      request: { amount: 1200 },
    });

    expect(result).toEqual({ id: "pi_123" });
    const openRequest = requests.find((request) => request.path === "/runs/open");
    expect(openRequest?.authorization).toBe("Bearer secret-token");
    const openMetadata = await readMetadata(openRequest?.body);
    expect(openMetadata).toMatchObject({
      protocolVersion: 1,
      branch: "main",
    });
    expect(openMetadata.files).toEqual([{ path: ".stepd/run.json", part: "file-0" }]);

    const commitRequests = requests.filter((request) => request.path.endsWith("/commit"));
    expect(commitRequests).toHaveLength(2);
    const startedMetadata = await readMetadata(commitRequests[0]?.body);
    expect(JSON.stringify(startedMetadata)).not.toContain("pi_123");
    const committedMetadata = await readMetadata(commitRequests[1]?.body);
    const committedEntry = committedMetadata.files.find(
      (entry: { path: string }) => entry.path.endsWith("/committed.json"),
    );
    expect(committedEntry).toBeDefined();
    await expect(readPart(commitRequests[1]?.body, committedEntry!.part)).resolves.toContain("pi_123");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function storeParts(
  body: FormData | undefined,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const metadata = await readMetadata(body);
  for (const entry of metadata.files) {
    files.set(entry.path, await readPartBytes(body, entry.part));
  }
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
