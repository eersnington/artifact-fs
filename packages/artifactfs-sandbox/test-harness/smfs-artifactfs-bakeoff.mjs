import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const outputRoot = path.join(repoRoot, ".bakeoff", "smfs-artifactfs");

const targetRepo = process.env.BAKEOFF_REPO ?? "https://github.com/supermemoryai/smfs.git";
const targetBranch = process.env.BAKEOFF_BRANCH ?? "main";
const benchmarkProfile = process.env.BAKEOFF_PROFILE ?? (targetRepo.includes("/smfs") ? "smfs" : "large");
const cloneModes = splitCsv(
  process.env.BAKEOFF_CLONE_MODES ??
    (benchmarkProfile === "large" ? "shallow,shallow-blobless,blobless,full" : "shallow,blobless"),
);
const sandboxUrl = process.env.ARTIFACTFS_SANDBOX_URL ?? process.env.SANDBOX_URL;
const sandboxToken = process.env.ARTIFACTS_SANDBOX_API_TOKEN;
const commandTimeoutMs = numberFromEnv("BAKEOFF_COMMAND_TIMEOUT_MS", 600_000);
const fetchTimeoutMs = numberFromEnv("BAKEOFF_FETCH_TIMEOUT_MS", 600_000);
const mountTimeoutMs = numberFromEnv("BAKEOFF_MOUNT_TIMEOUT_MS", 1_200_000);
const skipLocal = process.env.BAKEOFF_SKIP_LOCAL === "1" || process.env.BAKEOFF_SKIP_LOCAL === "true";
const runStamp = stamp();
const sandboxId = process.env.BAKEOFF_SANDBOX_ID ?? `${sanitizeName(repoNameFromRemote(targetRepo))}-${runStamp}`;
const artifactFsRepoName = process.env.BAKEOFF_ARTIFACTFS_REPO_NAME ?? sanitizeName(repoNameFromRemote(targetRepo));

await mkdir(outputRoot, { recursive: true });

const result = {
  targetRepo,
  targetBranch,
  benchmarkProfile,
  cloneModes,
  skipLocal,
  startedAt: new Date().toISOString(),
  localClones: skipLocal ? [] : await runLocalCloneBaselines(),
  artifactfs: sandboxUrl && sandboxToken
    ? await runArtifactFsBenchmark().catch((error) => ({
        failed: true,
        error: error instanceof Error ? error.message : String(error),
      }))
    : {
        skipped: true,
        reason: "Set ARTIFACTFS_SANDBOX_URL or SANDBOX_URL and ARTIFACTS_SANDBOX_API_TOKEN to run the Cloudflare ArtifactFS benchmark.",
      },
};

result.completedAt = new Date().toISOString();
const outputPath = path.join(outputRoot, `result-${stamp()}.json`);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, summary: summarize(result) }, null, 2));

async function runLocalCloneBaselines() {
  const baselines = [];
  for (const mode of cloneModes) {
    const destination = path.join(outputRoot, `${sanitizeName(repoNameFromRemote(targetRepo))}-${mode}`);
    await rm(destination, { recursive: true, force: true });
    const clone = await timed(`clone-${mode}`, cloneArgs(mode, destination));
    const steps = [];
    if (clone.success) {
      for (const step of benchmarkSteps(destination, benchmarkProfile, "clone")) {
        steps.push(await timed(step.name, ["bash", "-lc", step.command]));
      }
    }
    baselines.push({ mode, destination, clone, steps });
  }
  return baselines;
}

async function runArtifactFsBenchmark() {
  const mount = await mountArtifactFs();
  const benchmark = await postJson("/benchmark", {
    sandboxId,
    profile: benchmarkProfile,
    includeWrite: true,
  });
  return { mount, benchmark };
}

async function mountArtifactFs() {
  const startedAt = Date.now();
  const start = await postJson("/mount", {
    sandboxId,
    repoName: artifactFsRepoName,
    remote: targetRepo,
    branch: targetBranch,
    wait: false,
  });
  if (start.body.state !== "started") return start;

  while (Date.now() - startedAt < mountTimeoutMs) {
    await sleep(10_000);
    const result = await getJson("/mount-result", {
      sandboxId,
      jobId: start.body.jobId,
    });
    if (result.body.state === "running") continue;
    if (result.body.state === "complete") {
      return {
        durationMs: Date.now() - startedAt,
        attempts: start.attempts,
        body: result.body,
        start: start.body,
      };
    }
    throw new Error(`/mount failed: ${result.body.error ?? result.body.stderr ?? "mount job failed"}`);
  }
  throw new Error(`/mount failed: timed out after ${mountTimeoutMs}ms`);
}

function cloneArgs(mode, destination) {
  const args = ["git", "clone"];
  switch (mode) {
    case "full":
      break;
    case "shallow":
      args.push("--depth", "1");
      break;
    case "blobless":
      args.push("--filter=blob:none");
      break;
    case "shallow-blobless":
      args.push("--depth", "1", "--filter=blob:none");
      break;
    default:
      throw new Error(`unknown clone mode: ${mode}`);
  }
  args.push("--branch", targetBranch, targetRepo, destination);
  return args;
}

function benchmarkSteps(repoPath, profile, owner) {
  const repo = shellQuote(repoPath);
  const probePath = path.join(repoPath, ".supermemory-bakeoff", `${owner}-probe.txt`);
  const common = [
    {
      name: "first-useful-read",
      command: `git -C ${repo} rev-parse HEAD && ${readCommonFilesCommand(repoPath)}`,
    },
    {
      name: "git-status",
      command: `git -C ${repo} status --short --branch`,
    },
  ];

  const profileSteps = profile === "large"
    ? [
        {
          name: "tree-probe",
          command: treeProbeCommand(repoPath),
        },
        {
          name: "manifest-search",
          command: manifestSearchCommand(repoPath, "workspace|package|scripts|test|build"),
        },
      ]
    : [
        {
          name: "locate-smfs-semantic-grep",
          command: sourceSearchCommand(repoPath, "sgrep|semantic", [".rs", ".ts"]),
        },
        {
          name: "locate-profile-md",
          command: sourceSearchCommand(repoPath, "profile.md|PROFILE_NAME", []),
        },
      ];

  return [
    common[0],
    ...profileSteps,
    common[1],
    {
      name: "write-probe-file",
      command: `mkdir -p ${shellQuote(path.dirname(probePath))} && printf %s ${shellQuote(`${owner} baseline probe\nrepo=${targetRepo}\ncreated=${new Date().toISOString()}\n`)} > ${shellQuote(probePath)}`,
    },
    {
      name: "git-diff-after-write",
      command: `git -C ${repo} status --short && git -C ${repo} diff -- .supermemory-bakeoff/${owner}-probe.txt`,
    },
  ];
}

async function postJson(route, body) {
  const startedAt = Date.now();
  const attempts = route === "/mount" ? 12 : 4;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    const response = await fetch(`${sandboxUrl}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sandboxToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (response.ok) return { durationMs: Date.now() - startedAt, attempts: attempt, body: json };

    const message = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    lastError = new Error(`${route} failed: ${message}`);
    if (!isTransientSandboxError(message) || attempt === attempts) break;
    await sleep(5_000);
  }
  throw lastError;
}

async function getJson(route, params) {
  const url = new URL(`${sandboxUrl}${route}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${sandboxToken}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const message = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
      throw new Error(`${route} failed: ${message}`);
    }
    return { body: json };
  } finally {
    clearTimeout(timer);
  }
}

async function timed(name, argv) {
  const startedAt = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await exec(argv);
  return {
    name,
    argv,
    exitCode,
    timedOut,
    success: exitCode === 0 && !timedOut,
    durationMs: Date.now() - startedAt,
    stdout: truncate(stdout, 16_000),
    stderr: truncate(stderr, 16_000),
  };
}

function exec(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, commandTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function summarize(data) {
  return {
    profile: data.benchmarkProfile,
    repo: data.targetRepo,
    cloneModes: Object.fromEntries(
      data.localClones.map((entry) => [
        entry.mode,
        {
          cloneMs: entry.clone.durationMs,
          success: entry.clone.success,
          timedOut: entry.clone.timedOut,
          stepMs: Object.fromEntries(entry.steps.map((step) => [step.name, step.durationMs])),
        },
      ]),
    ),
    artifactfsSkipped: Boolean(data.artifactfs.skipped),
    artifactfsFailed: Boolean(data.artifactfs.failed),
    artifactfsError: data.artifactfs.error,
    artifactfsMountMs: data.artifactfs.mount?.durationMs,
    artifactfsBenchmarkMs: data.artifactfs.benchmark?.body?.durationMs,
    artifactfsStepMs: data.artifactfs.benchmark?.body?.steps
      ? Object.fromEntries(data.artifactfs.benchmark.body.steps.map((step) => [step.name, step.durationMs]))
      : undefined,
  };
}

function readCommonFilesCommand(root) {
  return `python3 - ${shellQuote(root)} <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
candidates = [
    'README.md', 'package.json', 'pnpm-workspace.yaml', 'turbo.json',
    'Cargo.toml', 'go.mod', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'
]
found = 0
for rel in candidates:
    path = root / rel
    if not path.is_file():
        continue
    data = path.read_bytes()[:65536]
    print(f"== {rel} bytes={path.stat().st_size} sample={len(data)} ==")
    print(data.decode('utf-8', errors='ignore').splitlines()[:20])
    found += 1
if found == 0:
    print('no common root manifest/readme files found')
    raise SystemExit(1)
PY`;
}

function treeProbeCommand(root) {
  return `python3 - ${shellQuote(root)} <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
rows = []
for path in root.rglob('*'):
    if any(part in {'.git', 'node_modules', 'target', 'dist', '.next'} for part in path.relative_to(root).parts):
        continue
    if len(path.relative_to(root).parts) > 3:
        continue
    rows.append(str(path.relative_to(root)))
    if len(rows) >= 120:
        break
print('\\n'.join(rows))
PY`;
}

function manifestSearchCommand(root, pattern) {
  return `python3 - ${shellQuote(root)} ${shellQuote(pattern)} <<'PY'
from pathlib import Path
import re, sys
root = Path(sys.argv[1])
regex = re.compile(sys.argv[2], re.IGNORECASE)
names = {'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pnpm-workspace.yaml', 'turbo.json'}
matches = 0
visited = 0
for path in root.rglob('*'):
    rel = path.relative_to(root)
    if any(part in {'.git', 'node_modules', 'target', 'dist', '.next'} for part in rel.parts):
        continue
    if len(rel.parts) > 5 or path.name not in names or not path.is_file():
        continue
    visited += 1
    try:
        for line_no, line in enumerate(path.read_text(encoding='utf-8', errors='ignore').splitlines(), 1):
            if regex.search(line):
                print(f"{rel}:{line_no}:{line}")
                matches += 1
                if matches >= 80:
                    raise SystemExit(0)
    except OSError:
        pass
    if visited >= 120:
        break
PY`;
}

function sourceSearchCommand(root, pattern, extensions) {
  return `python3 - ${shellQuote(root)} ${shellQuote(pattern)} ${shellQuote(extensions.join(","))} <<'PY'
import os, re, sys
root, pattern, raw_exts = sys.argv[1], sys.argv[2], sys.argv[3]
exts = {item for item in raw_exts.split(',') if item}
regex = re.compile(pattern)
count = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules', 'target', 'dist'}]
    for name in filenames:
        if exts and not any(name.endswith(ext) for ext in exts):
            continue
        path = os.path.join(dirpath, name)
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as handle:
                for line_no, line in enumerate(handle, 1):
                    if regex.search(line):
                        print(f"{path}:{line_no}:{line.rstrip()}")
                        count += 1
                        if count >= 40:
                            raise SystemExit(0)
        except OSError:
            pass
PY`;
}

function repoNameFromRemote(remote) {
  const trimmed = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/^.*:/, "") || "repo";
}

function sanitizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "repo";
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isTransientSandboxError(message) {
  return /container is starting|please retry|temporarily unavailable|timeout/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function stamp() {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} bytes]`;
}
