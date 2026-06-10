import { describe, expect, it } from "vitest";
import { readCapsuleFileBody } from "../src/core/file-content.js";
import { CapsuleError } from "../src/index.js";

const decoder = new TextDecoder();

describe("readCapsuleFileBody", () => {
  it("serializes JSON-like bodies as formatted JSON", async () => {
    const content = await readCapsuleFileBody("request.json", { amount: 1200 });

    expect(content.mediaType).toBe("application/json");
    expect(decoder.decode(content.bytes)).toBe('{\n  "amount": 1200\n}\n');
  });

  it("uses Blob media type before extension inference", async () => {
    const content = await readCapsuleFileBody(
      "response.json",
      new Blob(["ok"], { type: "text/plain" }),
    );

    expect(content.mediaType).toBe("text/plain");
    expect(decoder.decode(content.bytes)).toBe("ok");
  });

  it("rejects unserializable bodies with an invalid request error", async () => {
    await expect(
      readCapsuleFileBody("bad.json", undefined as never),
    ).rejects.toMatchObject({
      code: "INVALID_CAPSULE_REQUEST",
      retryable: false,
    } satisfies Partial<CapsuleError>);
  });
});
