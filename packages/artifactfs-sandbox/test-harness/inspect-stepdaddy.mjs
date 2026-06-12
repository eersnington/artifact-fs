import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.resolve(__dirname, "..");
const runsRoot = path.join(sandboxDir, "workflow-run-repos");

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const selector = args.find((arg) => !arg.startsWith("--"));

const includeFiles = flags.has("--files");
const asJson = flags.has("--json");
const stepSelector = optionValue("--step");
const callSelector = optionValue("--call");

try {
  const runs = await readRuns();
  if (selector === undefined) {
    if (asJson) {
      printJson(runs.map(summarizeRun));
    } else {
      printRunIndex(runs);
    }
    process.exit(0);
  }

  const run = findRun(runs, selector);
  if (run === undefined) {
    throw new CliError(`No Stepdaddy run matched "${selector}". Run without arguments to list available runs.`);
  }

  const selectedCall = selectCall(run, { stepSelector, callSelector });

  if (asJson) {
    printJson(selectedCall === undefined
      ? summarizeRun(run, { includeFiles: true })
      : summarizeCall(run, selectedCall, { includeFiles: true }));
  } else if (selectedCall !== undefined) {
    printCall(run, selectedCall, { includeFiles });
  } else {
    printRun(run, { includeFiles });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

async function readRuns() {
  const demoReport = await readDemoReport();
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(runsRoot, entry.name);
    const runPath = path.join(repoPath, ".stepd", "run.json");
    const runRecord = await readJson(runPath).catch(() => undefined);
    if (runRecord === undefined) continue;

    const calls = await readCalls(repoPath);
    runs.push({
      repoName: entry.name,
      repoPath,
      runRecord,
      calls,
      demo: demoReport.get(entry.name),
    });
  }

  return runs.sort((a, b) => {
    const aTime = Date.parse(String(a.runRecord.createdAt ?? ""));
    const bTime = Date.parse(String(b.runRecord.createdAt ?? ""));
    return bTime - aTime || a.repoName.localeCompare(b.repoName);
  });
}

async function readDemoReport() {
  const report = await readJson(path.join(runsRoot, "idempotency-demo-report.json")).catch(() => undefined);
  const entries = report?.runs;
  if (!Array.isArray(entries)) return new Map();
  return new Map(entries.map((entry) => [entry.repoName, normalizeDemoEntry(entry)]));
}

function normalizeDemoEntry(entry) {
  const legacyBehaviour = entry["scen" + "ario"];
  const { ["scen" + "ario"]: _, ...rest } = entry;
  return {
    ...rest,
    behaviour: entry.behaviour ?? legacyBehaviour,
  };
}

async function readCalls(repoPath) {
  const byKeyRoot = path.join(repoPath, ".stepd", "by-key");
  const entries = await fs.readdir(byKeyRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  const calls = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const keyHash = entry.name;
    const keyDir = path.join(byKeyRoot, keyHash);
    const requestPath = path.join(keyDir, "request.json");
    const committedPath = path.join(keyDir, "committed.json");
    const attemptsDir = path.join(keyDir, "attempts");

    const request = await readJson(requestPath).catch(() => undefined);
    const committed = await readJson(committedPath).catch(() => undefined);
    const attemptFiles = await listAttemptFiles(attemptsDir);
    const startedFiles = attemptFiles.filter((file) => file.endsWith("-started.json"));
    const errorFiles = attemptFiles.filter((file) => file.endsWith("-error.json"));
    const startedAttempts = await Promise.all(startedFiles.map(async (file) => ({
      file: relativeRepoPath(repoPath, path.join(attemptsDir, file)),
      record: await readJson(path.join(attemptsDir, file)).catch(() => undefined),
    })));
    const errorAttempts = await Promise.all(errorFiles.map(async (file) => ({
      file: relativeRepoPath(repoPath, path.join(attemptsDir, file)),
      record: await readJson(path.join(attemptsDir, file)).catch(() => undefined),
    })));
    const latestAttempt = latestAttemptNumber([...startedFiles, ...errorFiles]);
    const state = committed !== undefined
      ? "committed"
      : errorFiles.length > 0
        ? "errored"
        : startedFiles.length > 0
          ? "ambiguous"
          : "corrupt";

    calls.push({
      keyHash,
      callName: request?.callName ?? "unknown",
      requestDigest: request?.requestDigest,
      stepName: request?.step?.name ?? "unknown",
      stepCount: request?.step?.count,
      state,
      attempt: committed?.attempt ?? latestAttempt,
      externalId: committed?.summary?.externalId,
      status: committed?.summary?.status ?? committed?.status,
      committedAt: committed?.committedAt,
      records: {
        request,
        committed,
        startedAttempts,
        errorAttempts,
      },
      files: {
        request: relativeRepoPath(repoPath, requestPath),
        committed: committed === undefined ? undefined : relativeRepoPath(repoPath, committedPath),
        started: startedFiles.map((file) => relativeRepoPath(repoPath, path.join(attemptsDir, file))),
        errors: errorFiles.map((file) => relativeRepoPath(repoPath, path.join(attemptsDir, file))),
      },
    });
  }

  return calls.sort((a, b) => {
    const aStep = typeof a.stepCount === "number" ? a.stepCount : Number.MAX_SAFE_INTEGER;
    const bStep = typeof b.stepCount === "number" ? b.stepCount : Number.MAX_SAFE_INTEGER;
    return aStep - bStep || a.callName.localeCompare(b.callName);
  });
}

async function listAttemptFiles(attemptsDir) {
  const entries = await fs.readdir(attemptsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function findRun(runs, value) {
  return runs.find((run) => run.repoName === value || run.runRecord.instanceId === value)
    ?? runs.find((run) => run.repoName.includes(value) || String(run.runRecord.instanceId).includes(value));
}

function selectCall(run, options) {
  if (options.stepSelector === undefined && options.callSelector === undefined) return undefined;

  let matches = run.calls;
  if (options.stepSelector !== undefined) {
    const selector = options.stepSelector.toLowerCase();
    const numeric = Number(selector);
    matches = matches.filter((call, index) => {
      if (Number.isInteger(numeric) && numeric > 0) {
        return call.stepCount === numeric || index + 1 === numeric;
      }
      return call.stepName.toLowerCase().includes(selector);
    });
  }

  if (options.callSelector !== undefined) {
    const selector = options.callSelector.toLowerCase();
    matches = matches.filter((call) => call.callName.toLowerCase().includes(selector));
  }

  if (matches.length === 0) {
    const detail = [
      options.stepSelector === undefined ? undefined : `step "${options.stepSelector}"`,
      options.callSelector === undefined ? undefined : `call "${options.callSelector}"`,
    ].filter(Boolean).join(" and ");
    throw new CliError(`No capsule call matched ${detail}.`);
  }

  if (matches.length > 1) {
    throw new CliError(
      `Multiple capsule calls matched. Narrow with --step or --call. Matches: ${matches.map((call) => call.callName).join(", ")}`,
    );
  }

  return matches[0];
}

function summarizeRun(run, options = {}) {
  const calls = run.calls.map((call) => {
    const summary = {
      callName: call.callName,
      stepName: call.stepName,
      stepCount: call.stepCount,
      attempt: call.attempt,
      state: call.state,
      externalId: call.externalId,
      status: call.status,
    };
    return options.includeFiles ? { ...summary, files: call.files } : summary;
  });

  return {
    workflowName: run.runRecord.workflowName,
    instanceId: run.runRecord.instanceId,
    repoName: run.repoName,
    repoPath: path.relative(sandboxDir, run.repoPath),
    createdAt: run.runRecord.createdAt,
    workflowBehaviour: run.demo,
    calls,
  };
}

function summarizeCall(run, call, options = {}) {
  const summary = {
    workflowName: run.runRecord.workflowName,
    instanceId: run.runRecord.instanceId,
    repoName: run.repoName,
    repoPath: path.relative(sandboxDir, run.repoPath),
    callName: call.callName,
    stepName: call.stepName,
    stepCount: call.stepCount,
    attempt: call.attempt,
    state: call.state,
    externalId: call.externalId,
    status: call.status,
    workflowBehaviour: run.demo,
    request: call.records.request,
    attempts: [
      ...call.records.startedAttempts.map((attempt) => attempt.record),
      ...call.records.errorAttempts.map((attempt) => attempt.record),
    ].filter((record) => record !== undefined),
    committed: call.records.committed,
  };
  return options.includeFiles ? { ...summary, files: call.files } : summary;
}

function printRunIndex(runs) {
  if (runs.length === 0) {
    console.log("No capsule workflow run repos found.");
    return;
  }

  console.log("Workflow Runs\n");
  const rows = runs.map((run) => ({
    repo: run.repoName,
    behaviour: displayBehaviour(run.demo?.behaviour),
    workflow: String(run.runRecord.workflowName ?? "unknown"),
    instance: String(run.runRecord.instanceId ?? "unknown"),
    calls: String(run.calls.length),
    committed: String(run.calls.filter((call) => call.state === "committed").length),
    errors: String(run.calls.filter((call) => call.state === "errored").length),
    providerCalls: run.demo?.providerExecutions === undefined ? "-" : String(run.demo.providerExecutions),
    path: path.relative(sandboxDir, run.repoPath),
  }));
  printTable(rows, ["repo", "behaviour", "workflow", "instance", "calls", "committed", "errors", "providerCalls", "path"]);
}

function printRun(run, options) {
  console.log("Workflow Run");
  console.log(`workflow: ${run.runRecord.workflowName}`);
  console.log(`instance: ${run.runRecord.instanceId}`);
  console.log(`repo:     ${run.repoName}`);
  console.log(`path:     ${path.relative(sandboxDir, run.repoPath)}`);
  printWorkflowBehaviour(run.demo);
  console.log("\nTimeline");

  for (const [index, call] of run.calls.entries()) {
    console.log(`${index + 1}. ${call.callName}`);
    console.log(`   step: ${call.stepName}${call.stepCount === undefined ? "" : ` #${call.stepCount}`}`);
    console.log(`   attempt: ${call.attempt ?? "unknown"}`);
    console.log(`   state: ${call.state}`);
    if (call.externalId !== undefined) console.log(`   externalId: ${call.externalId}`);
    if (call.status !== undefined) console.log(`   status: ${call.status}`);

    if (options.includeFiles) {
      console.log("   files:");
      console.log(`     request:   ${call.files.request}`);
      for (const started of call.files.started) console.log(`     started:   ${started}`);
      for (const error of call.files.errors) console.log(`     error:     ${error}`);
      if (call.files.committed !== undefined) console.log(`     committed: ${call.files.committed}`);
    }

    if (index < run.calls.length - 1) console.log("");
  }
}

function printCall(run, call, options) {
  console.log("Workflow Run");
  console.log(`workflow: ${run.runRecord.workflowName}`);
  console.log(`instance: ${run.runRecord.instanceId}`);
  console.log(`repo:     ${run.repoName}`);
  printWorkflowBehaviour(run.demo);

  console.log("\nStep");
  console.log(`name: ${call.stepName}`);
  if (call.stepCount !== undefined) console.log(`count: ${call.stepCount}`);
  console.log(`call: ${call.callName}`);
  console.log(`state: ${call.state}`);
  console.log(`attempt: ${call.attempt ?? "unknown"}`);
  if (call.externalId !== undefined) console.log(`externalId: ${call.externalId}`);
  if (call.status !== undefined) console.log(`status: ${call.status}`);

  const request = call.records.request;
  if (request !== undefined) {
    console.log("\nRequest Record");
    console.log(`keyHash: ${request.keyHash}`);
    console.log(`requestDigest: ${request.requestDigest}`);
    console.log(`createdAt: ${request.createdAt}`);
  }

  if (call.records.startedAttempts.length > 0 || call.records.errorAttempts.length > 0) {
    console.log("\nAttempt Records");
    for (const attempt of call.records.startedAttempts) {
      if (attempt.record === undefined) continue;
      console.log(`- attempt: ${attempt.record.attempt}`);
      console.log(`  status: ${attempt.record.status}`);
      if (attempt.record.startedAt !== undefined) console.log(`  startedAt: ${attempt.record.startedAt}`);
    }
    for (const attempt of call.records.errorAttempts) {
      if (attempt.record === undefined) continue;
      console.log(`- attempt: ${attempt.record.attempt}`);
      console.log(`  status: ${attempt.record.status}`);
      if (attempt.record.failedAt !== undefined) console.log(`  failedAt: ${attempt.record.failedAt}`);
      if (attempt.record.error?.message !== undefined) console.log(`  error: ${attempt.record.error.message}`);
    }
  }

  const committed = call.records.committed;
  if (committed !== undefined) {
    console.log("\nCommitted Record");
    console.log(`status: ${committed.status}`);
    console.log(`committedAt: ${committed.committedAt}`);
    printFlatFields("result", committed.result);
    if (committed.summary !== undefined) printFlatFields("summary", committed.summary);
  }

  if (options.includeFiles) {
    console.log("\nFiles");
    console.log(`request:   ${call.files.request}`);
    for (const started of call.files.started) console.log(`started:   ${started}`);
    for (const error of call.files.errors) console.log(`error:     ${error}`);
    if (call.files.committed !== undefined) console.log(`committed: ${call.files.committed}`);
  }
}

function printWorkflowBehaviour(demo) {
  if (demo === undefined) return;
  console.log("\nWorkflow Behaviour");
  console.log(`type: ${displayBehaviour(demo.behaviour)}`);
  if (demo.providerExecutions !== undefined) console.log(`provider calls: ${demo.providerExecutions}`);
  if (demo.reconcileExecutions !== undefined) console.log(`reconcile calls: ${demo.reconcileExecutions}`);
  if (demo.sameResultReused !== undefined) console.log(`same result reused: ${demo.sameResultReused ? "yes" : "no"}`);
  if (demo.conflictCode !== undefined) console.log(`conflict code: ${demo.conflictCode}`);
  if (demo.secondErrorCode !== undefined) console.log(`second error code: ${demo.secondErrorCode}`);
  if (demo.proof !== undefined) console.log(`proof: ${demo.proof}`);
}

function displayBehaviour(value) {
  return value === undefined ? "-" : String(value).replaceAll("-", " ");
}

function printTable(rows, columns) {
  const widths = Object.fromEntries(columns.map((column) => [
    column,
    Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
  ]));
  console.log(columns.map((column) => column.padEnd(widths[column])).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column])).join("  "));
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column]).padEnd(widths[column])).join("  "));
  }
}

function printFlatFields(prefix, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === null || ["string", "number", "boolean"].includes(typeof fieldValue)) {
      console.log(`${prefix}.${key}: ${fieldValue}`);
    }
  }
}

function latestAttemptNumber(files) {
  const attempts = files
    .map((file) => Number(file.match(/^(\d+)-/)?.[1]))
    .filter((value) => Number.isFinite(value));
  return attempts.length === 0 ? undefined : Math.max(...attempts);
}

function relativeRepoPath(repoPath, filePath) {
  return path.relative(repoPath, filePath).split(path.sep).join("/");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError(`${name} requires a value`);
  }
  return value;
}

class CliError extends Error {}
