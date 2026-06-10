# workflow-capsules

Idempotency records for external calls inside Cloudflare Workflows.

Cloudflare Workflows retries failed steps. That is good for durable execution, but external APIs can commit side effects even when a step does not finish cleanly. Capsules records the lifecycle of external calls made inside steps, reuses known committed outputs on retry, and forces reconciliation when the outcome is ambiguous.

Capsules does not replace `step.do()`, retry config, rollback, `waitForEvent`, logs, metrics, R2, or Workflows state. Workflows owns execution. Capsules tracks the external side effect inside one retryable step.

## Install

```sh
npm i workflow-capsules
# or: pnpm add workflow-capsules
```

## Quick Start

```ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createCapsules, defineExternalCall } from "workflow-capsules";
import { cloudflare } from "workflow-capsules/cloudflare";

type ChargePayload = {
  readonly customerId: string;
  readonly amount: number;
  readonly currency: string;
};

type StripePaymentIntent = {
  readonly id: string;
  readonly object: "payment_intent";
  readonly status?: string;
};

export class ChargeCustomerWorkflow extends WorkflowEntrypoint<Env, ChargePayload> {
  async run(event: WorkflowEvent<ChargePayload>, step: WorkflowStep) {
    const capsules = createCapsules({ adapter: cloudflare(this.env.ARTIFACTS) });

    const createPaymentIntent = defineExternalCall<ChargePayload, StripePaymentIntent>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute: async ({ request, key }) => {
        const response = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.STRIPE_SECRET}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": key,
          },
          body: new URLSearchParams({
            customer: request.customerId,
            amount: String(request.amount),
            currency: request.currency,
          }),
        });
        const body = (await response.json()) as StripePaymentIntent;
        if (!response.ok) {
          throw new Error(`Stripe payment_intent.create failed with HTTP ${response.status}`);
        }
        return body;
      },
      summary: ({ request, result }) => ({
        externalId: result.id,
        status: result.status,
        amount: request.amount,
        currency: request.currency,
      }),
    });

    const charge = await step.do("charge customer", async (ctx) => {
      const intent = await capsules.call(createPaymentIntent, {
        workflow: event,
        step: ctx,
        key: `wf:${event.instanceId}:charge-customer`,
        request: event.payload,
      });

      return { paymentIntentId: intent.id };
    });

    return charge;
  }
}
```

The Workflow remains normal Cloudflare Workflows code:

```ts
const intent = await capsules.call(createPaymentIntent, {
  workflow: event,
  step: ctx,
  key: `wf:${event.instanceId}:charge-customer`,
  request: { customerId, amount, currency },
});

return { paymentIntentId: intent.id };
```

`capsules.call(...)` returns the provider result, not a Capsules metadata wrapper.

## Core API

### `defineExternalCall(spec)`

Defines a named provider operation once:

```ts
const createGitHubIssue = defineExternalCall<CreateIssueInput, CreatedIssue>({
  name: "github.issue.create",
  recovery: {
    reconcile: async ({ key, request }) => {
      const issue = await findIssueByMarker(request.owner, request.repo, key);
      if (!issue) return { status: "not_found" };
      return { status: "found", result: { number: issue.number, url: issue.html_url } };
    },
  },
  execute: async ({ request, key }) => {
    const issue = await createIssue({
      ...request,
      body: `${request.body}\n\n${key}`,
    });
    return { number: issue.number, url: issue.html_url };
  },
});
```

### `capsules.call(externalCall, context)`

Runs the provider operation inside a native `step.do` callback:

```ts
const issue = await step.do("tool github create issue", async (ctx) => {
  return capsules.call(createGitHubIssue, {
    workflow: event,
    step: ctx,
    key: `issue:${event.instanceId}:create`,
    request: { owner, repo, title, body },
  });
});
```

The `key` is required. It must be stable across retries for the same external side effect and must not include attempt number, time, or randomness.

## Recovery Policies

```ts
type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | { reconcile: (ctx: ReconcileContext<Request>) => Promise<ReconcileResult<Result>> };
```

`idempotent-call` repeats `execute` with the same key and same request after a prior started-without-result record. Use this for providers like Stripe that enforce idempotency keys.

`reconcile` reads provider state using a marker, external ID, webhook state, or application-owned lookup. A `found` result is stored and returned. `not_found` and `inconclusive` throw `SIDE_EFFECT_AMBIGUOUS` in the MVP.

`fail-closed` throws `SIDE_EFFECT_AMBIGUOUS` before repeating an unsafe provider call.

## What Capsules Records

For each call key, Capsules stores compact JSON records:

```txt
.calls/
  run.json
  by-key/<key-hash>/
    request.json
    started.json
    committed.json
    summary.json
    reconciled.json
    attempts/
      001-started.json
      001-error.json
```

Artifacts is the call-history store, not the product. Storage details are intentionally not part of the happy-path API.

## Failure Behavior

If a committed result already exists for the same key and request digest, Capsules returns it without executing provider code.

If the same key is reused with a different request digest, Capsules throws `SIDE_EFFECT_CONFLICT` before executing provider code.

If storage fails before the started record is persisted, Capsules throws and provider code is not invoked.

If provider code returns but the committed record cannot be persisted, Capsules throws `SIDE_EFFECT_STORAGE_FAILED`. A retry must use the configured recovery policy.

If provider code throws, Capsules keeps the started record and writes an attempt error record when possible, then rethrows the original error so Workflows retry config remains in charge.

Provider business declines should usually be returned as values, not thrown infrastructure errors, when callers want Capsules to store and reuse them.

## Errors

Capsules raises `CapsuleError` with these codes:

```txt
INVALID_EXTERNAL_CALL
SIDE_EFFECT_CONFLICT
SIDE_EFFECT_AMBIGUOUS
SIDE_EFFECT_STORAGE_FAILED
SIDE_EFFECT_RECONCILE_FAILED
```

Docs and applications can convert `SIDE_EFFECT_AMBIGUOUS` to Cloudflare `NonRetryableError` when a Workflow should stop retrying and require operator reconciliation.

## Adapters

```ts
import { cloudflare } from "workflow-capsules/cloudflare";
import { memory } from "workflow-capsules/memory";
import { local } from "workflow-capsules/local";
import { remote } from "workflow-capsules/remote";

createCapsules({ adapter: cloudflare(env.ARTIFACTS) });
createCapsules({ adapter: memory() });
createCapsules({ adapter: local({ root: "/tmp/capsules" }) });
createCapsules({ adapter: remote({ url: "http://127.0.0.1:8789", token }) });
```

`memory` is for tests. `local` is for development. `cloudflare` is the default Cloudflare-native production adapter. `remote` is for hosted call-history services.

## When Not To Use Capsules

Use plain `step.do()` when the step is read-only.

Use plain `step.do()` when repeating the call is harmless.

Use the provider's normal idempotency key directly if durable call history and guardrails are not useful.

Use R2 for arbitrary files and large blobs.

Use Workflows rollback for compensation after later failure.

Use `waitForEvent` for webhook-driven progression.

## Limits And Security

Capsules does not guarantee exactly-once provider execution. It makes retryable Workflow steps idempotency-aware by recording the side-effect boundary, checking request consistency, reusing committed results, and forcing explicit recovery when the outcome is ambiguous.

Capsules stores exactly the provider result and summary your code returns. Redact secrets and sensitive provider fields before returning or summarizing them.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
