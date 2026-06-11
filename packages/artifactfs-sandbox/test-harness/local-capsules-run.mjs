import { createCapsules, defineExternalCall } from "../../capsules/dist/index.js";
import { local } from "../../capsules/dist/local.js";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.resolve(__dirname, "..");
const outputRoot = path.join(sandboxDir, "workflow-run-repos");
const workflowName = "charge-customer-workflow";
const instanceId = `local-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;

await mkdir(outputRoot, { recursive: true });

const capsules = createCapsules({ adapter: local({ root: outputRoot }) });

const createPaymentIntent = defineExternalCall({
  name: "stripe.payment_intent.create",
  recovery: "idempotent-call",
  execute: async ({ request }) => ({
    id: `pi_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    object: "payment_intent",
    status: "succeeded",
    amount: request.amount,
    currency: request.currency,
  }),
  summary: ({ request, result }) => ({
    externalId: result.id,
    status: result.status,
    amount: request.amount,
    currency: request.currency,
  }),
});

const createInvoice = defineExternalCall({
  name: "stripe.invoice.create",
  recovery: "idempotent-call",
  execute: async ({ request }) => ({
    id: `in_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    object: "invoice",
    status: "open",
    paymentIntentId: request.paymentIntentId,
  }),
  summary: ({ request, result }) => ({
    externalId: result.id,
    status: result.status,
    paymentIntentId: request.paymentIntentId,
  }),
});

const workflow = { workflowName, instanceId };

const charge = await capsules.call(createPaymentIntent, {
  workflow,
  step: { attempt: 1, step: { name: "charge customer", count: 1 } },
  key: `wf:${instanceId}:charge-customer`,
  request: { customerId: "cus_capsule_harness", amount: 1200, currency: "usd" },
});

const invoice = await capsules.call(createInvoice, {
  workflow,
  step: { attempt: 1, step: { name: "create invoice", count: 2 } },
  key: `wf:${instanceId}:create-invoice`,
  request: { customerId: "cus_capsule_harness", paymentIntentId: charge.id },
});

const repoName = `capsule-${workflowName}-${instanceId}`;
const repoPath = path.join(outputRoot, repoName);

console.log(JSON.stringify({
  workflowName,
  instanceId,
  repoName,
  repoPath,
  result: {
    paymentIntentId: charge.id,
    invoiceId: invoice.id,
  },
}, null, 2));
