import { describe, expect, it, vi } from "vitest";
import {
  CapsuleError,
  createCapsules,
  defineExternalCall,
  type WorkflowEventLike,
  type WorkflowStepContextLike,
} from "../src/index.js";
import { memory } from "../src/memory.js";
import type { CallStore, CapsuleAdapter, InternalCapsuleAdapter, StandardSchemaV1 } from "../src/core/types.js";

function workflow(overrides?: Partial<WorkflowEventLike>): WorkflowEventLike {
  return {
    workflowName: "ChargeCustomerWorkflow",
    instanceId: "invoice-77",
    payload: {},
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

function step(name: string, count = 1, attempt = 1): WorkflowStepContextLike {
  return { step: { name, count }, attempt };
}

describe("capsules.call", () => {
  it("executes a provider call and stores a committed result", async () => {
    const adapter = memory();
    const capsules = createCapsules({ adapter });
    const execute = vi.fn(async ({ key }: { key: string }) => ({
      id: "pi_123",
      object: "payment_intent" as const,
      key,
    }));
    const createPaymentIntent = defineExternalCall<
      { customerId: string; amount: number; currency: string },
      { id: string; object: "payment_intent"; key: string }
    >({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute,
      summary: ({ request, result }) => ({
        externalId: result.id,
        amount: request.amount,
        currency: request.currency,
      }),
    });

    const result = await capsules.call(createPaymentIntent, {
      workflow: workflow(),
      step: step("charge customer"),
      key: "wf:invoice-77:charge-customer",
      request: { customerId: "cus_123", amount: 1200, currency: "usd" },
    });

    expect(result.id).toBe("pi_123");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a prior committed result across retry attempts without executing", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const execute = vi.fn(async () => ({ id: "pi_123" }));
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute,
    });

    const first = await capsules.call(call, {
      workflow: workflow(),
      step: step("charge customer", 1, 1),
      key: "wf:invoice-77:charge-customer",
      request: { amount: 1200 },
    });
    const second = await capsules.call(call, {
      workflow: workflow(),
      step: step("charge customer", 1, 2),
      key: "wf:invoice-77:charge-customer",
      request: { amount: 1200 },
    });

    expect(first).toEqual({ id: "pi_123" });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key with a different request before executing provider code", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const execute = vi.fn(async () => ({ id: "pi_123" }));
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute,
    });

    await capsules.call(call, {
      workflow: workflow(),
      step: step("charge customer"),
      key: "wf:invoice-77:charge-customer",
      request: { amount: 1200 },
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("charge customer", 1, 2),
        key: "wf:invoice-77:charge-customer",
        request: { amount: 1300 },
      }),
    ).rejects.toMatchObject({
      code: "SIDE_EFFECT_CONFLICT",
      retryable: false,
    } satisfies Partial<CapsuleError>);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a started record without a committed result", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "github.issue.create",
      recovery: "fail-closed",
      execute: vi.fn(async () => {
        throw new Error("provider timeout");
      }),
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 1),
        key: "issue-marker-1",
        request: { amount: 1200 },
      }),
    ).rejects.toThrow("provider timeout");

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 2),
        key: "issue-marker-1",
        request: { amount: 1200 },
      }),
    ).rejects.toMatchObject({ code: "SIDE_EFFECT_AMBIGUOUS" });
  });

  it("uses reconcile to recover a started call", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const execute = vi.fn(async () => {
      throw new Error("network died after provider accepted request");
    });
    const reconcile = vi.fn(async () => ({
      status: "found" as const,
      result: { number: 42, url: "https://github.example/42" },
    }));
    const call = defineExternalCall<{ title: string }, { number: number; url: string }>({
      name: "github.issue.create",
      recovery: { reconcile },
      execute,
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 1),
        key: "issue-marker-1",
        request: { title: "bug" },
      }),
    ).rejects.toThrow("network died");

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 2),
        key: "issue-marker-1",
        request: { title: "bug" },
      }),
    ).resolves.toEqual({ number: 42, url: "https://github.example/42" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats reconcile not_found as ambiguous", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const call = defineExternalCall<{ title: string }, { number: number }>({
      name: "github.issue.create",
      recovery: { reconcile: async () => ({ status: "not_found" }) },
      execute: async () => {
        throw new Error("timeout");
      },
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 1),
        key: "issue-marker-1",
        request: { title: "bug" },
      }),
    ).rejects.toThrow("timeout");

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("create issue", 1, 2),
        key: "issue-marker-1",
        request: { title: "bug" },
      }),
    ).rejects.toMatchObject({ code: "SIDE_EFFECT_AMBIGUOUS" });
  });

  it("does not invoke provider code when started record storage fails", async () => {
    const store: CallStore = {
      kind: "failing",
      async openRun() {
        return {
          repo: "repo",
          branch: "main",
          async readFile() {
            return null;
          },
          async readHead() {
            return undefined;
          },
          async commitFiles() {
            throw new Error("disk full");
          },
        };
      },
    };
    const adapter = { kind: "memory", store } as InternalCapsuleAdapter as CapsuleAdapter;
    const capsules = createCapsules({ adapter });
    const execute = vi.fn(async () => ({ id: "pi_123" }));
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute,
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("charge customer"),
        key: "wf:invoice-77:charge-customer",
        request: { amount: 1200 },
      }),
    ).rejects.toMatchObject({ code: "SIDE_EFFECT_STORAGE_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates request schemas before execution", async () => {
    const capsules = createCapsules({ adapter: memory() });
    const requestSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          const input = value as { amount: number };
          return input.amount > 0
            ? { value: input }
            : { issues: [{ message: "amount must be positive" }] };
        },
      },
    } satisfies StandardSchemaV1<unknown, { amount: number }>;
    const execute = vi.fn(async () => ({ id: "pi_123" }));
    const call = defineExternalCall<{ amount: number }, { id: string }>({
      name: "stripe.payment_intent.create",
      request: requestSchema,
      recovery: "idempotent-call",
      execute,
    });

    await expect(
      capsules.call(call, {
        workflow: workflow(),
        step: step("charge customer"),
        key: "wf:invoice-77:charge-customer",
        request: { amount: 0 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXTERNAL_CALL" });
    expect(execute).not.toHaveBeenCalled();
  });
});
