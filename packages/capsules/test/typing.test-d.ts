import { expectTypeOf } from "vitest";
import { createCapsules, defineExternalCall, type ExternalCallSpec } from "../src/index.js";
import { memory } from "../src/memory.js";

type ChargeInput = {
  customerId: string;
  amount: number;
  currency: string;
};

type PaymentIntent = {
  id: string;
  object: "payment_intent";
};

const workflow = { workflowName: "ChargeWorkflow", instanceId: "charge-1" };
const step = { step: { name: "charge customer", count: 1 }, attempt: 1 };

const spec = {
  name: "stripe.payment_intent.create",
  recovery: "idempotent-call",
  execute: async ({ request, key, attempt }) => {
    expectTypeOf(request).toEqualTypeOf<ChargeInput>();
    expectTypeOf(key).toEqualTypeOf<string>();
    expectTypeOf(attempt).toEqualTypeOf<number>();
    return { id: request.customerId, object: "payment_intent" as const };
  },
  summary: ({ request, result }) => {
    expectTypeOf(request).toEqualTypeOf<ChargeInput>();
    expectTypeOf(result).toEqualTypeOf<PaymentIntent>();
    return { externalId: result.id };
  },
} satisfies ExternalCallSpec<ChargeInput, PaymentIntent>;

const createPaymentIntent = defineExternalCall(spec);
const capsules = createCapsules({ adapter: memory() });

expectTypeOf(
  capsules.call(createPaymentIntent, {
    workflow,
    step,
    key: "wf:charge-1:charge-customer",
    request: { customerId: "cus_123", amount: 1200, currency: "usd" },
  }),
).toEqualTypeOf<Promise<PaymentIntent>>();

void capsules.call(createPaymentIntent, {
  workflow,
  step,
  key: "wf:charge-1:charge-customer",
  // @ts-expect-error - ChargeInput requires currency.
  request: { customerId: "cus_123", amount: 1200 },
});

defineExternalCall<ChargeInput, PaymentIntent>({
  name: "github.issue.create",
  recovery: {
    reconcile: async ({ request }) => {
      expectTypeOf(request).toEqualTypeOf<ChargeInput>();
      return { status: "found", result: { id: "pi_123", object: "payment_intent" } };
    },
  },
  execute: async () => ({ id: "pi_123", object: "payment_intent" }),
});
