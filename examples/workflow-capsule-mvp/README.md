# Workflow Capsule MVP

This example shows `workflow-capsules` capturing durable Workflow side effects into Cloudflare Artifacts instead of storing large outputs in Workflow state.

The example Workflow is Stripe-shaped on purpose: it shows idempotency keys, retries, external object ids, redacted request/response files, side-effect audit manifests, and small refs passed from one step to the next.

## What Goes Where

Workflow state stores only `CapsuleRefs`:

```txt
charge.output.paymentIntentId
charge.output.responsePath
charge.artifact.repo
charge.artifact.commit
```

Artifacts stores the file tree and Git history:

```txt
.capsule/run.json
.capsule/index.json
steps/001-charge-customer/attempts/1/manifest.json
steps/001-charge-customer/attempts/1/effects/stripe-payment-intent-create.json
steps/001-charge-customer/attempts/1/files/request/redacted.json
steps/001-charge-customer/attempts/1/files/response/payment-intent.json
steps/002-create-invoice/attempts/1/files/response/invoice.json
```

Each capsule-producing step creates a Git commit in the run repo, so you can inspect the exact timeline with `git log`, `git diff`, and `git show`.

## Configure Cloudflare

`wrangler.jsonc` enables the Workflow, Artifacts binding, and `nodejs_compat` because the MVP Workers layer uses `isomorphic-git` with an in-memory filesystem:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
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

## Why Capsule Instead Of Returning A Stream?

JavaScript Workflows can return `ReadableStream<Uint8Array>` from `step.do()` for a single large binary output. Capsule is for the cases where the output is not just one blob:

- a multi-file tree with paths and media types
- versioned snapshots per durable step
- diffs between steps and retry attempts
- side-effect audit files for providers like Stripe, AI, webhooks, or email
- redacted request/response fixtures for debugging
- approvals and provenance bound to immutable Git commits

Capsule keeps Workflows as the durable execution engine and lets Artifacts be the durable file/versioning layer.

## Swap Layers

The Workflow body does not change when the artifact capability changes:

```ts
Capsules.layer(Artifacts.workers(env.ARTIFACTS));
Capsules.layer(Artifacts.localBridge({ url: "http://127.0.0.1:8789" }));
Capsules.layer(Artifacts.localNode({ mountRoot: "/tmp/capsules" }));
Capsules.layer(Artifacts.hosted({ url: "https://artifact-service.example.com", token }));
```

`workflow-capsules` also exports `createLocalBridgeHandler({ mountRoot })` so a local Node service can back `Artifacts.localBridge(...)` with the same HTTP protocol used by hosted mode.

## MVP Caveat

The Workers binding layer uses `isomorphic-git` and buffers the working tree in Worker memory. That is fine for small-to-medium artifacts and API validation. Very large trees should use the local bridge or hosted layer once their streaming upload path is implemented.
