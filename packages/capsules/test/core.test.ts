import { describe, expect, it, vi } from "vitest";
import {
  Artifacts,
  CapsuleError,
  Capsules,
  stableHash,
  type ArtifactLayer,
  type WorkflowEventLike,
  type WorkflowStepContextLike,
} from "../src/index.js";
import { DEFAULT_BRANCH } from "../src/git/layout.js";
import type { InternalArtifactLayer, StandardSchemaV1 } from "../src/core/types.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function workflow(overrides?: Partial<WorkflowEventLike>): WorkflowEventLike {
  return {
    workflowName: "ChargeCustomerWorkflow",
    instanceId: "invoice-77",
    payload: {},
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

function step(
  name: string,
  count = 1,
  attempt = 1,
): WorkflowStepContextLike {
  return { step: { name, count }, attempt };
}

async function readJson<T>(
  layer: ArtifactLayer,
  refs: { artifact: { repo: string }; workflow: { name: string; instanceId: string } },
  path: string,
): Promise<T> {
  const session = await internalLayer(layer).backend.openRun({
    workflowName: refs.workflow.name,
    instanceId: refs.workflow.instanceId,
    repoName: refs.artifact.repo,
    branch: DEFAULT_BRANCH,
    initFiles: new Map(),
    initMessage: "init",
  });
  const bytes = await session.readFile(path);
  if (bytes === null) throw new Error(`missing ${path}`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

async function readText(
  layer: ArtifactLayer,
  refs: { artifact: { repo: string }; workflow: { name: string; instanceId: string } },
  path: string,
): Promise<string> {
  const session = await internalLayer(layer).backend.openRun({
    workflowName: refs.workflow.name,
    instanceId: refs.workflow.instanceId,
    repoName: refs.artifact.repo,
    branch: DEFAULT_BRANCH,
    initFiles: new Map(),
    initMessage: "init",
  });
  const bytes = await session.readFile(path);
  if (bytes === null) throw new Error(`missing ${path}`);
  return decoder.decode(bytes);
}

function internalLayer(layer: ArtifactLayer): InternalArtifactLayer {
  return layer as InternalArtifactLayer;
}

describe("Capsules.capture with memory artifacts", () => {
  it("writes file refs, output, manifests, and effect audit records", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);

    const refs = await capsules.capture({
      workflow: workflow(),
      step: step("charge customer"),
      name: "stripe-payment-intent",
      idempotencyKey: "wf:invoice-77:charge-customer:1",
      input: { customerId: "cus_123", amount: 1200, currency: "usd" },
      run: async ({ input, files, effects, idempotencyKey }) => {
        await files.write("request/redacted.json", {
          ...input,
          idempotencyKey,
        });
        await files.write("response/payment-intent.json", {
          id: "pi_123",
          object: "payment_intent",
        });
        await files.write("output/answer.md", "approved\n");
        await files.write("binary/raw.bin", new Uint8Array([1, 2, 3]));
        await files.write(
          "stream/chunk.txt",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("streamed"));
              controller.close();
            },
          }),
        );
        await files.write("blob/plain.txt", new Blob(["blob"]));

        await effects.record("stripe.payment_intent.create", {
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          externalId: "pi_123",
          httpStatus: 200,
          requestHash: await stableHash(input),
        });

        return {
          paymentIntentId: "pi_123",
          responsePath: "response/payment-intent.json",
        };
      },
    });

    expect(refs.artifact.backend).toBe("memory");
    expect(refs.artifact.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(refs.artifact.parent).toMatch(/^[a-f0-9]{40}$/);
    expect(refs.output.paymentIntentId).toBe("pi_123");
    expect(Object.keys(refs.files).sort()).toEqual([
      "binary/raw.bin",
      "blob/plain.txt",
      "output/answer.md",
      "request/redacted.json",
      "response/payment-intent.json",
      "stream/chunk.txt",
    ]);
    expect(refs.files["response/payment-intent.json"]?.mediaType).toBe(
      "application/json",
    );
    expect(refs.files["binary/raw.bin"]?.digest).toMatch(/^sha256:/);

    const manifest = await readJson<{
      effects: Array<{ path: string; details: Record<string, unknown> }>;
      files: Record<string, unknown>;
      artifact: { parent?: string };
      output: { paymentIntentId: string };
    }>(layer, refs, refs.manifestPath);
    expect(manifest.artifact.parent).toBe(refs.artifact.parent);
    expect(manifest.output.paymentIntentId).toBe("pi_123");
    expect(manifest.effects[0]?.path).toContain(
      "effects/stripe-payment-intent-create.json",
    );
    expect(manifest.effects[0]?.details).not.toHaveProperty("status");
    expect(manifest.effects[0]?.details).not.toHaveProperty("outcome");

    const effect = await readJson<{
      workflow: { instanceId: string };
      step: { name: string; attempt: number };
      idempotencyKey?: string;
      details: { externalId?: string; httpStatus?: number };
    }>(layer, refs, manifest.effects[0]!.path);
    expect(effect.workflow.instanceId).toBe("invoice-77");
    expect(effect.step).toEqual({ name: "charge customer", count: 1, attempt: 1 });
    expect(effect.idempotencyKey).toBe("wf:invoice-77:charge-customer:1");
    expect(effect.details).toMatchObject({ externalId: "pi_123", httpStatus: 200 });

    await expect(
      readText(layer, refs, refs.files["stream/chunk.txt"]!.path),
    ).resolves.toBe("streamed");
    await expect(
      readText(layer, refs, refs.files["blob/plain.txt"]!.path),
    ).resolves.toBe("blob");
  });

  it("returns existing refs for the same committed step attempt and input", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);
    const run = vi.fn(async () => ({ path: "output/result.txt" }));

    const first = await capsules.capture({
      workflow: workflow(),
      step: step("produce report"),
      name: "report",
      input: { reportId: "r1" },
      run,
    });
    const second = await capsules.capture({
      workflow: workflow(),
      step: step("produce report"),
      name: "report",
      input: { reportId: "r1" },
      run,
    });

    expect(second.artifact.commit).toBe(first.artifact.commit);
    expect(second.output).toEqual(first.output);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("hashes the schema-validated input passed to run", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);
    const inputSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          const input = value as { amount: number };
          return { value: { amount: input.amount * 2 } };
        },
      },
    } satisfies StandardSchemaV1<unknown, { amount: number }>;

    const refs = await capsules.capture({
      workflow: workflow(),
      step: step("coerce input"),
      name: "coerced-input",
      input: { amount: 600 },
      inputSchema,
      run: async ({ input }) => ({ amount: input.amount }),
    });

    expect(refs.capsule.inputHash).toBe(await stableHash({ amount: 1200 }));
    expect(refs.output.amount).toBe(1200);
  });

  it("raises a non-retryable conflict when an existing attempt has a different input hash", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);

    await capsules.capture({
      workflow: workflow(),
      step: step("produce report"),
      name: "report",
      input: { reportId: "r1" },
      run: async () => ({ path: "output/result.txt" }),
    });

    await expect(
      capsules.capture({
        workflow: workflow(),
        step: step("produce report"),
        name: "report",
        input: { reportId: "r2" },
        run: async () => ({ path: "output/result.txt" }),
      }),
    ).rejects.toMatchObject({
      code: "CAPSULE_CONFLICT",
      retryable: false,
    } satisfies Partial<CapsuleError>);
  });

  it("records retry attempts under distinct attempt directories", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);

    const firstAttempt = await capsules.capture({
      workflow: workflow(),
      step: step("create invoice", 1, 1),
      name: "invoice",
      input: { paymentIntentId: "pi_123" },
      run: async ({ files }) => {
        await files.write("response/invoice.json", { id: "in_1" });
        return { invoiceId: "in_1" };
      },
    });
    const secondAttempt = await capsules.capture({
      workflow: workflow(),
      step: step("create invoice", 1, 2),
      name: "invoice",
      input: { paymentIntentId: "pi_123" },
      run: async ({ files }) => {
        await files.write("response/invoice.json", { id: "in_2" });
        return { invoiceId: "in_2" };
      },
    });

    expect(firstAttempt.manifestPath).toContain("attempts/1/manifest.json");
    expect(secondAttempt.manifestPath).toContain("attempts/2/manifest.json");
    expect(secondAttempt.artifact.parent).toBe(firstAttempt.artifact.commit);
    expect(secondAttempt.output.invoiceId).toBe("in_2");

    const inspected = await capsules.inspectRun({
      workflowName: "ChargeCustomerWorkflow",
      instanceId: "invoice-77",
    });
    expect(inspected.entries.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it("writes a failure manifest when the producer crossed an effect boundary", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);

    await expect(
      capsules.capture({
        workflow: workflow(),
        step: step("charge customer"),
        name: "stripe-payment-intent",
        idempotencyKey: "wf:invoice-77:charge-customer:1",
        input: { customerId: "cus_123" },
        run: async ({ effects }) => {
          await effects.record("stripe.payment_intent.create", {
            externalId: "pi_123",
            httpStatus: 500,
          });
          throw new Error("provider accepted request but returned 500");
        },
      }),
    ).rejects.toThrow("provider accepted request");

    const inspected = await capsules.inspectRun({
      workflowName: "ChargeCustomerWorkflow",
      instanceId: "invoice-77",
    });
    expect(inspected.entries).toHaveLength(1);
    expect(inspected.entries[0]).toMatchObject({ status: "failed" });

    const failure = await readJson<{
      externalEffectPossible: boolean;
      effects: Array<{ details: { externalId?: string } }>;
      error: { message: string; retryable: boolean };
    }>(
      layer,
      {
        artifact: { repo: inspected.repo },
        workflow: { name: "ChargeCustomerWorkflow", instanceId: "invoice-77" },
      },
      inspected.entries[0]!.manifestPath,
    );
    expect(failure.externalEffectPossible).toBe(true);
    expect(failure.effects[0]?.details.externalId).toBe("pi_123");
    expect(failure.error.retryable).toBe(true);
  });

  it("rejects traversal paths before committing", async () => {
    const layer = Artifacts.memory();
    const capsules = Capsules.layer(layer);

    await expect(
      capsules.capture({
        workflow: workflow(),
        step: step("unsafe"),
        name: "unsafe",
        input: {},
        run: async ({ files }) => {
          await files.write("../secret.txt", "nope");
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_REQUEST" });

    const inspected = await capsules.inspectRun({
      workflowName: "ChargeCustomerWorkflow",
      instanceId: "invoice-77",
    });
    expect(inspected.entries).toEqual([]);
  });
});
