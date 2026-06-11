import { createCapsules, defineExternalCall } from "../../capsules/dist/index.js";
import { local } from "../../capsules/dist/local.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.resolve(__dirname, "..");
const outputRoot = path.join(sandboxDir, "workflow-run-repos");
const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

await mkdir(outputRoot, { recursive: true });

const reports = [];

reports.push(await idempotentReplayWorkflow());
reports.push(await requestConflictWorkflow());
reports.push(await reconcileRecoveryWorkflow());
reports.push(await failClosedWorkflow());

const report = {
  createdAt: new Date().toISOString(),
  runs: reports,
};

await writeFile(
  path.join(outputRoot, "idempotency-demo-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);

console.log(JSON.stringify(report, null, 2));

async function idempotentReplayWorkflow() {
  const workflowName = "idempotent-replay-workflow";
  const instanceId = `demo-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const repoName = repoNameFor(workflowName, instanceId);
  await resetRepo(repoName);

  let providerExecutions = 0;
  const capsules = createCapsules({ adapter: local({ root: outputRoot }) });
  const call = defineExternalCall({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute: async ({ request }) => {
      providerExecutions += 1;
      return {
        id: "pi_replay_once",
        object: "payment_intent",
        status: "succeeded",
        amount: request.amount,
      };
    },
    summary: ({ request, result }) => ({
      externalId: result.id,
      status: result.status,
      amount: request.amount,
    }),
  });

  const workflow = { workflowName, instanceId };
  const context = {
    workflow,
    key: `wf:${instanceId}:charge-customer`,
    request: { amount: 1200 },
  };
  const first = await capsules.call(call, {
    ...context,
    step: step("charge customer", 1, 1),
  });
  const second = await capsules.call(call, {
    ...context,
    step: step("charge customer", 1, 2),
  });

  return {
    behaviour: "idempotent replay",
    workflowName,
    instanceId,
    repoName,
    providerExecutions,
    firstResultId: first.id,
    secondResultId: second.id,
    sameResultReused: first.id === second.id,
    proof: "same key/request reused the committed result; provider executed once",
  };
}

async function requestConflictWorkflow() {
  const workflowName = "request-conflict-workflow";
  const instanceId = `demo-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const repoName = repoNameFor(workflowName, instanceId);
  await resetRepo(repoName);

  let providerExecutions = 0;
  let conflictCode;
  const capsules = createCapsules({ adapter: local({ root: outputRoot }) });
  const call = defineExternalCall({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute: async ({ request }) => {
      providerExecutions += 1;
      return {
        id: "pi_original_request",
        object: "payment_intent",
        status: "succeeded",
        amount: request.amount,
      };
    },
    summary: ({ request, result }) => ({
      externalId: result.id,
      status: result.status,
      amount: request.amount,
    }),
  });

  const workflow = { workflowName, instanceId };
  await capsules.call(call, {
    workflow,
    step: step("charge customer", 1, 1),
    key: `wf:${instanceId}:charge-customer`,
    request: { amount: 1200 },
  });

  try {
    await capsules.call(call, {
      workflow,
      step: step("charge customer", 1, 2),
      key: `wf:${instanceId}:charge-customer`,
      request: { amount: 1300 },
    });
  } catch (error) {
    conflictCode = error?.code ?? error?.name ?? "Error";
  }

  return {
    behaviour: "request conflict",
    workflowName,
    instanceId,
    repoName,
    providerExecutions,
    conflictCode,
    proof: "same key with changed request failed before provider execution",
  };
}

async function reconcileRecoveryWorkflow() {
  const workflowName = "reconcile-recovery-workflow";
  const instanceId = `demo-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const repoName = repoNameFor(workflowName, instanceId);
  await resetRepo(repoName);

  let providerExecutions = 0;
  let reconcileExecutions = 0;
  let firstError;
  const capsules = createCapsules({ adapter: local({ root: outputRoot }) });
  const call = defineExternalCall({
    name: "github.issue.create",
    recovery: {
      reconcile: async () => {
        reconcileExecutions += 1;
        return {
          status: "found",
          result: { number: 42, url: "https://github.example/issues/42" },
        };
      },
    },
    execute: async () => {
      providerExecutions += 1;
      throw new Error("network died after provider accepted request");
    },
    summary: ({ result }) => ({
      externalId: String(result.number),
      status: "reconciled",
      url: result.url,
    }),
  });

  const workflow = { workflowName, instanceId };
  const input = {
    workflow,
    key: `wf:${instanceId}:create-issue`,
    request: { title: "bug" },
  };
  try {
    await capsules.call(call, { ...input, step: step("create issue", 1, 1) });
  } catch (error) {
    firstError = error?.message ?? String(error);
  }
  const recovered = await capsules.call(call, { ...input, step: step("create issue", 1, 2) });

  return {
    behaviour: "reconcile recovery",
    workflowName,
    instanceId,
    repoName,
    providerExecutions,
    reconcileExecutions,
    firstError,
    recoveredIssueNumber: recovered.number,
    proof: "retry reconciled a provider result after an errored started attempt",
  };
}

async function failClosedWorkflow() {
  const workflowName = "fail-closed-workflow";
  const instanceId = `demo-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const repoName = repoNameFor(workflowName, instanceId);
  await resetRepo(repoName);

  let providerExecutions = 0;
  let firstError;
  let secondErrorCode;
  const capsules = createCapsules({ adapter: local({ root: outputRoot }) });
  const call = defineExternalCall({
    name: "github.issue.create",
    recovery: "fail-closed",
    execute: async () => {
      providerExecutions += 1;
      throw new Error("provider timeout after request was accepted");
    },
  });

  const workflow = { workflowName, instanceId };
  const input = {
    workflow,
    key: `wf:${instanceId}:create-issue`,
    request: { title: "bug" },
  };
  try {
    await capsules.call(call, { ...input, step: step("create issue", 1, 1) });
  } catch (error) {
    firstError = error?.message ?? String(error);
  }
  try {
    await capsules.call(call, { ...input, step: step("create issue", 1, 2) });
  } catch (error) {
    secondErrorCode = error?.code ?? error?.name ?? "Error";
  }

  return {
    behaviour: "fail closed",
    workflowName,
    instanceId,
    repoName,
    providerExecutions,
    firstError,
    secondErrorCode,
    proof: "retry failed closed as ambiguous and did not execute provider again",
  };
}

function step(name, count, attempt) {
  return { attempt, step: { name, count } };
}

function repoNameFor(workflowName, instanceId) {
  return `capsule-${workflowName}-${instanceId}`;
}

async function resetRepo(repoName) {
  await rm(path.join(outputRoot, repoName), { recursive: true, force: true });
}
