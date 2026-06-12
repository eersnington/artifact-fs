# Stepdaddy Workflow Example

This example shows `stepdaddy` recording idempotency-aware external calls inside Cloudflare Workflow steps.

The Workflow is Stripe-shaped on purpose: it demonstrates stable idempotency keys, request digest guards, committed result reuse, and compact call-history records in Cloudflare Artifacts.

## What Goes Where

Workflow state stores normal domain output:

```txt
paymentIntentId
invoiceId
```

Stepdaddy stores compact call records in Artifacts:

```txt
.stepd/run.json
.stepd/by-key/<key-hash>/request.json
.stepd/by-key/<key-hash>/committed.json
.stepd/by-key/<key-hash>/attempts/001-started.json
.stepd/by-key/<key-hash>/attempts/001-error.json
```

Workflows owns execution and retry config. Stepdaddy tracks the external side-effect boundary inside the step.

## Configure Cloudflare

`wrangler.jsonc` enables the Workflow and Artifacts binding. The `cloudflare(...)` adapter uses the binding for repo/token operations and a Worker-compatible Git path for compact call-history commits.

```jsonc
{
  "workflows": [
    {
      "name": "charge-customer-workflow",
      "binding": "CHARGE_CUSTOMER_WORKFLOW",
      "class_name": "ChargeCustomerWorkflow"
    }
  ],
  "artifacts": [
    {
      "binding": "ARTIFACTS",
      "namespace": "default"
    }
  ]
}
```

Set the Stripe secret as a Worker secret:

```sh
pnpm exec wrangler secret put STRIPE_SECRET
```

For local testing without real Stripe, pass `stripeBaseUrl` in the Workflow payload and point it at a test server that implements `/v1/payment_intents` and `/v1/invoices`.

## Run

```sh
pnpm install
pnpm typecheck
pnpm dev
```

Start a Workflow:

```sh
curl -X POST http://localhost:8787/charge \
  -H 'content-type: application/json' \
  -d '{"customerId":"cus_123","amount":1200,"currency":"usd"}'
```

Check status:

```sh
curl http://localhost:8787/status/<workflow-instance-id>
```

## Why Stepdaddy

Plain Workflows plus Stripe idempotency is already useful. Stepdaddy adds a durable record around the provider call:

```txt
same key + same request -> reuse committed result
same key + different request -> reject before provider execution
started without committed result -> retry idempotently, reconcile, or fail closed
```

Stepdaddy does not guarantee exactly-once provider execution and does not replace rollback. Use Workflows rollback to compensate successful forward steps when later steps fail.

## Swap Adapters

The Workflow body does not change when the call-history adapter changes:

```ts
import { cloudflare } from "stepdaddy/cloudflare";
import { local } from "stepdaddy/local";
import { memory } from "stepdaddy/memory";
import { remote } from "stepdaddy/remote";

createStepdaddy({ adapter: cloudflare(env.ARTIFACTS) });
createStepdaddy({ adapter: local({ root: "/tmp/stepdaddy" }) });
createStepdaddy({ adapter: memory() });
createStepdaddy({ adapter: remote({ url: "http://127.0.0.1:8789", token }) });
```
