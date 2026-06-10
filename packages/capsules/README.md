# workflow-capsules

Durable, versioned artifact capture for Cloudflare Workflows steps.

A Workflow step often produces a file tree that is too large, too important, or too evolving to store as Workflow state: AI responses, build artifacts, generated reports, database dumps, provider fixtures. Capsule turns that file tree into a Git commit in a [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repo and returns small, serializable refs that fit Workflow state.

Capsule does not wrap or replace `step.do()`. Workflows stays the durable execution engine; Artifacts becomes the durable file and versioning layer.

```txt
Workflow step.do(...)
  -> capsules.capture(...)
  -> user code produces files
  -> backend commits the tree to a Git run repo
  -> Workflow state stores refs only
```

## Install

```sh
npm i workflow-capsules
# or: pnpm add workflow-capsules
```

## Quick Start

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createCapsules } from "workflow-capsules";
import { cloudflare } from "workflow-capsules/cloudflare";

export class ChargeCustomerWorkflow extends WorkflowEntrypoint<Env, ChargePayload> {
  async run(event: WorkflowEvent<ChargePayload>, step: WorkflowStep) {
    const capsules = createCapsules({ adapter: cloudflare(this.env.ARTIFACTS) });

    const charge = await step.do("charge customer", async (ctx) => {
      return capsules.capture(
        {
          workflow: event,
          step: ctx,
          name: "stripe-payment-intent",
          input: {
            customerId: event.payload.customerId,
            amount: event.payload.amount,
            currency: event.payload.currency,
          },
          idempotencyKey: `wf:${event.instanceId}:charge-customer:${ctx.step.count}`,
        },
        async ({ input, effects, idempotencyKey }) => {
          const response = await fetch("https://api.stripe.com/v1/payment_intents", {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.STRIPE_SECRET}`,
              "content-type": "application/x-www-form-urlencoded",
              "idempotency-key": idempotencyKey!,
            },
            body: new URLSearchParams({
              customer: input.customerId,
              amount: String(input.amount),
              currency: input.currency,
            }),
          });
          const body = await response.json<StripePaymentIntent>();

          const effect = await effects.record("stripe.payment_intent.create", {
            externalId: body.id,
            httpStatus: response.status,
            request: { ...input, idempotencyKey },
            response: { id: body.id, status: body.status },
          });
          if (!response.ok) {
            throw new Error(`Stripe payment_intent.create failed with ${response.status}`);
          }

          return {
            paymentIntentId: body.id,
            effectPath: effect.path,
          };
        },
      );
    });

    // Workflow state stores only refs; the file tree lives in Artifacts.
    return { paymentIntentId: charge.output.paymentIntentId, commit: charge.artifact.commit };
  }
}
```

## Adapters

Pick the adapter once; Workflow step bodies never change across adapters.

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

For the local bridge, run a Node service backed by the same protocol:

```ts
import { createServer } from "node:http";
import { createLocalBridgeHandler } from "workflow-capsules";

const handle = createLocalBridgeHandler({ mountRoot: "/tmp/capsules" });
// Adapt Node req/res to Fetch Request/Response, or use any Fetch-native server.
```

The bridge writes plain Git repos under `mountRoot`; inspect them with `git log`, `git diff`, or mount them with ArtifactFS.

## Core API

### `capsules.capture(options, run)`

Captures one side-effectful step. Requires `workflow` (the `WorkflowEvent`) and `step` (the `WorkflowStepContext` that `step.do()` passes to its callback) so Capsule can derive run identity, step identity, and attempt numbers.

Returns `CapsuleRefs<Output>`:

```ts
{
  capsule:  { name, id, inputHash, idempotencyKey?, dedupeKey? },
  workflow: { name, instanceId, stepName, stepCount, attempt },
  artifact: { adapter, repo, branch, commit, parent? },
  files:    Record<string, { path, mediaType?, size?, digest? }>, // only files exposed with exposeAs
  effects:  CapsuleEffectRef[],
  effectCount: number,
  output:   Output,           // your small serializable result
  manifestPath: string,
  diff?:    { base, head },
}
```

Replay-safe: if the same logical step with the same input hash is already committed, `capture()` returns the existing refs without re-running the producer. A committed logical step with a *different* input hash raises a non-retryable `CAPSULE_CONFLICT`.

### `files.write(path, body, options?)`

The single file-writing primitive. Accepts JSON-like objects, strings, `Uint8Array`, `ArrayBuffer`, `Blob`, and `ReadableStream<Uint8Array>`. Paths are relative, `/`-separated, and traversal-free. File bodies are buffered before commit; do not pass very large files or streams.

### `effects.record(kind, record)`

Writes a side-effect record for an external call that **already happened** — it does not call the provider. Use this for provider operations such as `stripe.payment_intent.create`, `sendgrid.email.send`, or `github.issue.create`.

Capsule adds workflow, instance id, step, attempt, timestamps, input hash, and idempotency key automatically. You can provide concrete provider facts such as `externalId`, `httpStatus`, `metadata`, and optional `request`/`response` snapshots. Capsule writes those snapshots under the effect directory and records their size and digest automatically.

Capsule stores exactly what you pass to `effects.record()` and `files.write()`. Artifact repos are access-controlled, but they are durable Git history. Shape, omit, or transform sensitive fields before recording or writing them.

### `Capsules.define<Input, Output>(definition)`

Reusable typed operations shared by multiple Workflows:

```ts
const buildArtifacts = Capsules.define<BuildInput, BuildOutput>({
  name: "build-artifacts",
  run: async ({ input, files }) => { /* ... */ },
});

await step.do("capture build artifacts", (ctx) =>
  capsules.capture(buildArtifacts.with({ workflow: event, step: ctx, input })),
);
```

`define()` also accepts an optional Standard Schema-compatible `input` schema for runtime validation.

### Automatic Metadata

- `inspectRun({ workflowName, instanceId })` — run summary from `.capsule/index.json` plus manifests.
- `input.hash` is computed automatically from the validated capture input.
- `files.write()` refs include automatic size and digest metadata.
- `effects.record()` request/response refs include automatic size and digest metadata.

## Run Repo Layout

One Artifact repo per Workflow run timeline; one commit per capsule-producing step attempt.

```txt
.capsule/
  run.json
  index.json
steps/
  001-charge-customer/
    attempts/
      1/
        manifest.json          # or failure.json for failed attempts
        input.hash.json
        output.json
        effects/
          001-stripe-payment-intent-create/
            record.json
            request.json
            response.json
        files/
          output/answer.md
```

What Git gives you:

```txt
git log --oneline      # chronological durable step timeline
git diff b2..c3        # exact files changed by a step or retry
git show c3:steps/001-charge-customer/attempts/1/manifest.json
```

## Failure Behavior

When the producer throws, Capsule rethrows the original error so `step.do()` retry semantics keep working. If the attempt crossed a side-effect boundary (files written, effects recorded, or an idempotency key present), Capsule first commits a `failure.json` recording the error, retryability, and whether an external effect may have succeeded. If a prior attempt already committed a success for the same logical step and input, a later retry reuses that success instead of re-running the producer.

Capsule's own errors are tagged `CapsuleError`s with codes `INVALID_CAPSULE_REQUEST`, `CAPSULE_CONFLICT`, `BACKEND_UNAVAILABLE`, `BACKEND_WRITE_FAILED`, and `OPERATION_FAILED`, plus a `retryable` flag.

## When To Use Capsule vs. Stream Returns

JavaScript Workflows can return a `ReadableStream<Uint8Array>` from `step.do()` for one large binary output consumed within the run. Use Capsule when the output is more than one blob:

- multi-file trees with paths and media types
- versioned snapshots, diffs, and retry visibility per durable step
- side-effect audit trails for providers (payments, AI, email, webhooks)
- artifacts that outlive Workflow state retention or are consumed by other systems

## Limits

- `cloudflare(...)` buffers a short-lived working tree in Worker memory via `isomorphic-git`; fine for small-to-medium artifacts, not for huge dumps.
- Stream bodies passed to `files.write()` are buffered before commit.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

See `examples/workflow-capsule-mvp` in this repository for a complete Worker + Workflow example.
