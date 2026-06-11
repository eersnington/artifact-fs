# workflow-capsules

Idempotency records for external side effects inside Cloudflare Workflows.

Workflows retries failed `step.do()` callbacks and caches successful step output. Capsules does not replace that. Capsules records one external provider call inside a retryable step so retries can reuse a committed provider result, reject a changed request for the same key, or stop for reconciliation when the outcome is unknown.

Capsules does not provide exactly-once execution. Provider safety still depends on provider idempotency keys, reconciliation APIs, durable markers, or choosing to fail closed.

## Install

```sh
npm i workflow-capsules
pnpm add workflow-capsules
```

## Usage

Define the provider operation once, then call it inside native `step.do()`.

```ts
import { createCapsules, defineExternalCall } from "workflow-capsules";
import { cloudflare } from "workflow-capsules/cloudflare";

const createPaymentIntent = defineExternalCall<ChargeInput, PaymentIntent>({
  name: "stripe.payment_intent.create",
  recovery: "idempotent-call",
  execute: async ({ request, key }) => {
    const response = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": key,
      },
      body: new URLSearchParams({
        customer: request.customerId,
        amount: String(request.amount),
        currency: request.currency,
      }),
    });

    const body = (await response.json()) as PaymentIntent;
    if (!response.ok) throw new Error(`Stripe failed with HTTP ${response.status}`);
    return { id: body.id, status: body.status };
  },
  summary: ({ request, result }) => ({
    externalId: result.id,
    status: result.status,
    amount: request.amount,
    currency: request.currency,
  }),
});

const capsules = createCapsules({ adapter: cloudflare(env.ARTIFACTS) });

const charge = await step.do("charge customer", async (ctx) => {
  const intent = await capsules.call(createPaymentIntent, {
    workflow: event,
    step: ctx,
    key: `wf:${event.instanceId}:charge-customer`,
    request: { customerId, amount, currency },
  });

  return { paymentIntentId: intent.id };
});
```

`capsules.call(...)` returns the provider result, not a Capsules wrapper.

## Requirements

The `key` is required. It must identify one external side effect and must be stable across retries. Do not include attempt number, time, randomness, or changing request data in the key.

The `request` and provider `result` must be JSON-serializable. Capsules compares the serialized request digest for conflict detection, so build request objects deterministically.

Return expected provider business outcomes as values when they should be stored and reused. Throw only for infrastructure or unexpected failures.

Redact secrets before returning provider results or summaries. Capsules stores exactly what `execute` returns and exactly what `summary` returns.

## Recovery

```ts
type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | { reconcile: (ctx: ReconcileContext<Request>) => Promise<ReconcileResult<Result>> };
```

`idempotent-call` repeats `execute` with the same key and same serialized request after a previous attempt started but did not record a result. Use this only when the provider enforces idempotency for that key, such as Stripe `Idempotency-Key`.

`reconcile` reads provider state using a marker, external ID, webhook state, or application-owned lookup. `found` stores and returns the result. `not_found` and `inconclusive` throw `SIDE_EFFECT_AMBIGUOUS`; absence is not treated as safe to retry.

`fail-closed` throws `SIDE_EFFECT_AMBIGUOUS` before repeating the provider call.

## Stored Records

For each key, Capsules stores compact JSON records:

```txt
.capsule/
  run.json
  by-key/<key-hash>/
    request.json
    committed.json
    attempts/
      001-started.json
      001-error.json
```

`committed.json` stores the provider result. If `summary` is configured, it is stored there too. Reconciled results are stored in the same file with `status: "reconciled"`.

Storage is an implementation detail. The Workflow should return its normal domain output.

## Failure Semantics

If a committed result exists for the same key and serialized request digest, Capsules returns it without running `execute`.

If the same key is reused with a different serialized request digest, Capsules throws `SIDE_EFFECT_CONFLICT` before running `execute`.

If storage fails before the started record is persisted, Capsules throws and `execute` is not run.

If `execute` returns but the committed record cannot be persisted, Capsules throws `SIDE_EFFECT_STORAGE_FAILED`. The next retry follows the configured recovery policy.

If `execute` throws, Capsules keeps the started record, writes an attempt error when possible, and rethrows the original error so Workflows retry config remains in charge.

## Errors

Capsules raises `CapsuleError` with these codes:

```txt
INVALID_EXTERNAL_CALL
SIDE_EFFECT_CONFLICT
SIDE_EFFECT_AMBIGUOUS
SIDE_EFFECT_STORAGE_FAILED
SIDE_EFFECT_RECONCILE_FAILED
```

Convert `SIDE_EFFECT_AMBIGUOUS` to Cloudflare `NonRetryableError` when the Workflow should stop and require operator reconciliation.

## Adapters

```ts
import { cloudflare } from "workflow-capsules/cloudflare";
import { memory } from "workflow-capsules/memory";
import { local } from "workflow-capsules/local";
import { remote } from "workflow-capsules/remote";

createCapsules({ adapter: cloudflare(env.ARTIFACTS) });
createCapsules({ adapter: memory() });
createCapsules({ adapter: local({ root: "/tmp/capsules" }) });
createCapsules({ adapter: remote({ url, token }) });
```

Use `memory` for tests, `local` for development, `cloudflare` for Cloudflare-native production storage, and `remote` for a hosted record store.

## Do Not Use Capsules For

Use plain `step.do()` for read-only or harmlessly repeatable work.

Use the provider idempotency key directly when you do not need stored records, request conflict checks, or ambiguous-outcome handling.

Use R2 for files and large blobs.

Use Workflows rollback for compensation after a later step fails.

Use `waitForEvent` for webhook-driven progression.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
