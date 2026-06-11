# workflow-capsules

Idempotency records for external side effects inside Cloudflare Workflows.

Workflows already retries failed `step.do()` callbacks and caches successful step output. Capsules adds what is missing for one external provider call inside a retryable step:

- reuse the committed provider result on retry
- reject a changed request for the same key
- stop for reconciliation when the outcome is unknown

Capsules does not provide exactly-once execution. Provider safety still depends on provider idempotency keys, reconciliation, or failing closed.

## Install

```sh
npm i workflow-capsules
```

## Quick Start

Define the provider call once, then run it inside a native `step.do()`.

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

    if (!response.ok) throw new Error(`Stripe failed with HTTP ${response.status}`);
    const body = (await response.json()) as PaymentIntent;
    return { id: body.id, status: body.status };
  },
});

const capsules = createCapsules({ adapter: cloudflare(env.ARTIFACTS) });

await step.do("charge customer", async (ctx) => {
  const intent = await capsules.call(createPaymentIntent, {
    workflow: event,
    step: ctx,
    key: `wf:${event.instanceId}:charge-customer`,
    request: { customerId, amount, currency },
  });

  return { paymentIntentId: intent.id };
});
```

`capsules.call(...)` returns the provider result directly, not a wrapper.

## Rules

1. `key` identifies exactly one external side effect and must be stable across retries. Never include attempt numbers, timestamps, or randomness.
2. `request` and `result` must be JSON-serializable. The request digest uses `JSON.stringify`, so build request objects deterministically.
3. Return expected provider outcomes as values so they are stored and reused. Throw only for infrastructure or unexpected failures.
4. Redact secrets. Capsules stores exactly what `execute` and `summary` return.

## Retry Behavior

What happens when a step retries `capsules.call(...)` with the same key:

| State from the previous attempt              | Behavior                                            |
| -------------------------------------------- | --------------------------------------------------- |
| Result committed, same request digest        | Returns the stored result; `execute` does not run   |
| Result committed, different request digest   | Throws `SIDE_EFFECT_CONFLICT`; `execute` does not run |
| Attempt started, no result recorded          | Follows the `recovery` policy                       |
| No record                                    | Runs `execute` normally                             |

Other failure cases:

- Storage fails before the started record is persisted: Capsules throws and `execute` does not run.
- `execute` succeeds but the result cannot be persisted: Capsules throws `SIDE_EFFECT_STORAGE_FAILED`; the next retry follows the recovery policy.
- `execute` throws: Capsules records the attempt error when possible and rethrows the original error, leaving Workflows retry config in charge.

## API

### `createCapsules(options): Capsules`

| Option    | Type             | Description                              |
| --------- | ---------------- | ---------------------------------------- |
| `adapter` | `CapsuleAdapter` | Storage adapter. See [Adapters](#adapters). |

### `defineExternalCall<Request, Result>(spec): ExternalCall<Request, Result>`

| Field      | Type                                              | Required | Description |
| ---------- | ------------------------------------------------- | -------- | ----------- |
| `name`     | `string`                                          | yes      | Stable identifier for the provider operation, e.g. `"stripe.payment_intent.create"`. |
| `recovery` | `ExternalCallRecovery`                            | yes      | What to do when a previous attempt started but recorded no result. See [Recovery](#recovery). |
| `execute`  | `(ctx) => Promise<Result>`                        | yes      | Performs the provider call. Receives `{ request, key, workflow, step, attempt }`. |
| `request`  | Standard Schema                                   | no       | Validates the request before any record is written. |
| `result`   | Standard Schema                                   | no       | Validates the result before it is stored. |
| `summary`  | `(ctx) => Record<string, unknown>`                | no       | Compact audit fields stored with the result. Receives the execute context plus `result`. |

### `capsules.call(externalCall, context): Promise<Result>`

| Field      | Type                      | Description |
| ---------- | ------------------------- | ----------- |
| `workflow` | `WorkflowEvent`-like      | The Workflow event; provides `instanceId` and `workflowName`. |
| `step`     | `WorkflowStepContext`-like | The `step.do()` callback context. |
| `key`      | `string`                  | Stable idempotency key for this side effect. |
| `request`  | `Request`                 | The provider request payload. |

### Recovery

```ts
type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | { reconcile: (ctx: ReconcileContext<Request>) => Promise<ReconcileResult<Result>> };
```

| Policy             | Behavior |
| ------------------ | -------- |
| `"idempotent-call"` | Repeats `execute` with the same key and request. Only safe when the provider enforces idempotency for that key, such as Stripe `Idempotency-Key`. |
| `"fail-closed"`     | Throws `SIDE_EFFECT_AMBIGUOUS` instead of repeating the provider call. |
| `{ reconcile }`     | Looks up provider state (external ID, marker, webhook state). `{ status: "found", result }` stores and returns the result. `not_found` and `inconclusive` throw `SIDE_EFFECT_AMBIGUOUS`; absence is not treated as safe to retry. |

### Errors

All failures are `CapsuleError` with a `code`:

| Code                          | Meaning |
| ----------------------------- | ------- |
| `INVALID_EXTERNAL_CALL`       | Bad spec or call input, including schema validation failures. |
| `SIDE_EFFECT_CONFLICT`        | Same key reused with a different request digest. |
| `SIDE_EFFECT_AMBIGUOUS`       | Outcome unknown and the policy refuses to repeat the call. |
| `SIDE_EFFECT_STORAGE_FAILED`  | The result could not be persisted after `execute` succeeded. |
| `SIDE_EFFECT_RECONCILE_FAILED` | The `reconcile` function itself threw. |

Convert `SIDE_EFFECT_AMBIGUOUS` to Cloudflare `NonRetryableError` when the Workflow should stop for operator reconciliation.

### Adapters

```ts
import { cloudflare } from "workflow-capsules/cloudflare";
import { memory } from "workflow-capsules/memory";
import { local } from "workflow-capsules/local";
import { remote } from "workflow-capsules/remote";

createCapsules({ adapter: cloudflare(env.ARTIFACTS) }); // production on Cloudflare
createCapsules({ adapter: memory() });                  // unit tests, ephemeral
createCapsules({ adapter: local({ root: "/tmp/capsules" }) }); // development, Node-only
createCapsules({ adapter: remote({ url, token }) });    // hosted record store
```

## Stored Records

Per key, Capsules stores compact JSON records: the request digest, one started/error record per attempt, and `committed.json` holding the result, the optional summary, and `status: "committed" | "reconciled"`. Storage is an implementation detail; your Workflow returns its normal domain output.

## When Not to Use Capsules

- Read-only or harmlessly repeatable work: plain `step.do()`.
- Provider idempotency key alone is enough: call the provider directly.
- Files and large blobs: R2.
- Compensation after a later step fails: Workflows rollback.
- Webhook-driven progression: `waitForEvent`.