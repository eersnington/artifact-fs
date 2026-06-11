import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export class ArtifactsSandbox extends Sandbox {}

type Env = {
  ARTIFACTS_SANDBOX: DurableObjectNamespace<ArtifactsSandbox>;
  ARTIFACTS_SANDBOX_API_TOKEN?: string;
};

type MountRequest = {
  readonly sandboxId?: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly gitUsername?: string;
  readonly gitPassword?: string;
};

type MountConfig = {
  readonly sandboxId: string;
  readonly remote: string;
  readonly branch: string;
  readonly repoName: string;
  readonly mountPath: string;
  readonly gitUsername?: string;
  readonly gitPassword?: string;
  readonly env: Record<string, string>;
};

type StoredMountMetadata = {
  readonly remote: string;
  readonly branch: string;
  readonly repoName: string;
  readonly mountPath: string;
};

const DEFAULT_BRANCH = "main";
const DEFAULT_MOUNT_ROOT = "/workspace/mnt";
const DEFAULT_ARTIFACT_FS_ROOT = "/tmp/artifact-fs";
const DEFAULT_METADATA_FILE = "/workspace/.artifact-fs-mount";
const MOUNT_SCRIPT = "/usr/local/bin/mount-artifact-fs-repo";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTING_LINES = 200;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(helpText(), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/mount") {
      return handleMount(request, env);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return handleStatus(request, env);
    }

    if (request.method === "GET" && url.pathname === "/tree") {
      return handleTree(request, env);
    }

    if (request.method === "GET" && url.pathname === "/file") {
      return handleFile(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleMount(request: Request, env: Env): Promise<Response> {
  try {
    authorizeRequest(request, env);
    const body = await parseMountRequest(request);
    const config = buildMountConfig(
      body.sandboxId,
      body.remote,
      body.branch,
      body.gitUsername,
      body.gitPassword,
    );
    const sandbox = getSandbox(env.ARTIFACTS_SANDBOX, config.sandboxId, {
      normalizeId: true,
      sleepAfter: "15m",
    });

    const existingMetadata = await readMountMetadata(sandbox);
    const mountConflict = compareMountMetadata(existingMetadata, config);
    if (mountConflict !== null) {
      return Response.json({ error: mountConflict }, { status: 409 });
    }

    const bootstrap = await runChecked(sandbox, MOUNT_SCRIPT, "ArtifactFS bootstrap failed", {
      cwd: "/workspace",
      env: config.env,
      timeout: 120_000,
    });
    const repo = await collectMountedRepoState(sandbox, config.repoName, config.mountPath);
    const root = await listRepoPath(sandbox, config.mountPath, ".");

    return Response.json({
      sandboxId: config.sandboxId,
      remote: config.remote,
      branch: config.branch,
      repoName: config.repoName,
      mountPath: config.mountPath,
      bootstrapLog: bootstrap.stdout.trim(),
      root,
      ...repo,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  try {
    authorizeRequest(request, env);
    const sandbox = await sandboxFromQuery(request, env);
    const metadata = await requireMountMetadata(sandbox);
    const repo = await collectMountedRepoState(sandbox, metadata.repoName, metadata.mountPath);

    return Response.json({
      metadata,
      ...repo,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleTree(request: Request, env: Env): Promise<Response> {
  try {
    authorizeRequest(request, env);
    const url = new URL(request.url);
    const repoPath = cleanRepoPath(url.searchParams.get("path") ?? ".");
    const sandbox = await sandboxFromQuery(request, env);
    const metadata = await requireMountMetadata(sandbox);
    const entries = await listRepoPath(sandbox, metadata.mountPath, repoPath);

    return Response.json({
      path: repoPath,
      entries,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleFile(request: Request, env: Env): Promise<Response> {
  try {
    authorizeRequest(request, env);
    const url = new URL(request.url);
    const repoPath = cleanRepoPath(url.searchParams.get("path") ?? "");
    if (repoPath === ".") {
      throw new UserError("path must identify a file", 400);
    }

    const sandbox = await sandboxFromQuery(request, env);
    const metadata = await requireMountMetadata(sandbox);
    const target = `${metadata.mountPath}/${repoPath}`;
    const size = await readFileSize(sandbox, target);
    if (size > MAX_FILE_BYTES) {
      throw new UserError(`file is too large to read through this endpoint (${size} bytes)`, 413);
    }

    const binaryCheck = await runChecked(
      sandbox,
      `python3 - <<'PY'\nfrom pathlib import Path\ndata = Path(${JSON.stringify(target)}).read_bytes()\nprint("binary" if b"\\0" in data else "text")\nPY`,
      "Could not inspect file type",
    );
    if (binaryCheck.stdout.trim() === "binary") {
      throw new UserError("binary files are not supported by this endpoint", 415);
    }

    const file = await sandbox.readFile(target);
    return new Response(file.content, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function parseMountRequest(request: Request): Promise<MountRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new UserError("Request body must be valid JSON", 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new UserError("Request body must be a JSON object", 400);
  }

  const { sandboxId, remote, branch, gitUsername, gitPassword } = body as Record<string, unknown>;
  validateOptionalString("sandboxId", sandboxId);
  validateOptionalString("remote", remote);
  validateOptionalString("branch", branch);
  validateOptionalString("gitUsername", gitUsername);
  validateOptionalString("gitPassword", gitPassword);

  if (remote === undefined) {
    throw new UserError("remote is required", 400);
  }

  return {
    sandboxId: sandboxId as string | undefined,
    remote: remote as string,
    branch: branch as string | undefined,
    gitUsername: gitUsername as string | undefined,
    gitPassword: gitPassword as string | undefined,
  };
}

function buildMountConfig(
  sandboxIdInput: string | undefined,
  remoteInput: string | undefined,
  branchInput: string | undefined,
  gitUsernameInput: string | undefined,
  gitPasswordInput: string | undefined,
): MountConfig {
  const remote = normalizeRemote(remoteInput ?? "");
  const branch = (branchInput ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  const gitUsername = gitUsernameInput?.trim();
  const gitPassword = gitPasswordInput?.trim();
  validateGitCredentials(gitUsername, gitPassword);
  validateBranch(branch);
  const repoName = inferRepoName(remote);
  const sandboxId = sandboxIdInput === undefined
    ? normalizeSandboxId(crypto.randomUUID())
    : normalizeRequestedSandboxId(sandboxIdInput);
  const mountPath = `${DEFAULT_MOUNT_ROOT}/${repoName}`;

  return {
    sandboxId,
    remote,
    branch,
    repoName,
    mountPath,
    ...(gitUsername === undefined ? {} : { gitUsername }),
    ...(gitPassword === undefined ? {} : { gitPassword }),
    env: removeUndefinedValues({
      MOUNT_GIT_REMOTE: remote,
      MOUNT_GIT_BRANCH: branch,
      MOUNT_GIT_USERNAME: gitUsername,
      MOUNT_GIT_PASSWORD: gitPassword,
      ARTIFACT_FS_ROOT: DEFAULT_ARTIFACT_FS_ROOT,
      MOUNT_ROOT: DEFAULT_MOUNT_ROOT,
      ARTIFACT_FS_MOUNT_METADATA_FILE: DEFAULT_METADATA_FILE,
    }),
  };
}

async function sandboxFromQuery(request: Request, env: Env) {
  const url = new URL(request.url);
  const sandboxId = url.searchParams.get("sandboxId");
  if (sandboxId === null) {
    throw new UserError("Missing sandboxId query parameter", 400);
  }
  return getSandbox(env.ARTIFACTS_SANDBOX, normalizeRequestedSandboxId(sandboxId), {
    normalizeId: true,
    sleepAfter: "15m",
  });
}

function normalizeRemote(value: string): string {
  const remote = value.trim();
  if (remote.startsWith("https://")) {
    const parsed = new URL(remote);
    if (parsed.username !== "" || parsed.password !== "") {
      throw new UserError("remote must not include credentials", 400);
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      throw new UserError("remote must not include query parameters or fragments", 400);
    }
    if (parsed.pathname === "" || parsed.pathname === "/") {
      throw new UserError("remote must include a repository path", 400);
    }
    return remote;
  }

  if (remote.startsWith("ssh://")) {
    const parsed = new URL(remote);
    if (parsed.password !== "") {
      throw new UserError("remote must not include passwords", 400);
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      throw new UserError("remote must not include query parameters or fragments", 400);
    }
    if (parsed.pathname === "" || parsed.pathname === "/") {
      throw new UserError("remote must include a repository path", 400);
    }
    return remote;
  }

  if (/^[^@:\s]+@[^:\s]+:.+/.test(remote)) {
    return remote;
  }

  throw new UserError("remote must be an HTTPS or SSH Git URL", 400);
}

function inferRepoName(remote: string): string {
  const trimmed = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
  const repoName = trimmed.slice(lastSeparator + 1);
  if (repoName === "") {
    throw new UserError("remote must include a repository name", 400);
  }
  return repoName;
}

async function collectMountedRepoState(
  sandbox: ReturnType<typeof getSandbox>,
  repoName: string,
  mountPath: string,
) {
  const artifactFsStatus = await runChecked(
    sandbox,
    `artifact-fs status --name ${shellQuote(repoName)}`,
    "Could not read ArtifactFS status",
  );
  const mounted = /(^|\s)state=mounted(\s|$)/.test(artifactFsStatus.stdout);
  if (!mounted) {
    return {
      head: null,
      gitStatus: null,
      artifactFsStatus: artifactFsStatus.stdout.trim(),
    };
  }

  const [head, gitStatus] = await Promise.all([
    runChecked(sandbox, `git -C ${shellQuote(mountPath)} rev-parse HEAD`, "Could not read mounted HEAD"),
    runChecked(sandbox, `git -C ${shellQuote(mountPath)} status --short --branch`, "Could not read mounted git status"),
  ]);

  return {
    head: head.stdout.trim(),
    gitStatus: gitStatus.stdout.trim(),
    artifactFsStatus: artifactFsStatus.stdout.trim(),
  };
}

async function listRepoPath(
  sandbox: ReturnType<typeof getSandbox>,
  mountPath: string,
  repoPath: string,
): Promise<ReadonlyArray<{ name: string; type: "file" | "directory" | "symlink" | "other" }>> {
  const target = repoPath === "." ? mountPath : `${mountPath}/${repoPath}`;
  const command = `python3 - <<'PY'\nimport json, os\npath = ${JSON.stringify(target)}\nentries = []\nfor name in sorted(os.listdir(path))[:${MAX_LISTING_LINES}]:\n    full = os.path.join(path, name)\n    if os.path.islink(full):\n        kind = "symlink"\n    elif os.path.isdir(full):\n        kind = "directory"\n    elif os.path.isfile(full):\n        kind = "file"\n    else:\n        kind = "other"\n    entries.append({"name": name, "type": kind})\nprint(json.dumps(entries))\nPY`;
  const result = await runChecked(sandbox, command, "Could not list mounted path");
  return JSON.parse(result.stdout) as ReadonlyArray<{ name: string; type: "file" | "directory" | "symlink" | "other" }>;
}

async function readFileSize(sandbox: ReturnType<typeof getSandbox>, target: string): Promise<number> {
  const result = await runChecked(
    sandbox,
    `python3 - <<'PY'\nimport os\nprint(os.path.getsize(${JSON.stringify(target)}))\nPY`,
    "Could not read file size",
  );
  return Number(result.stdout.trim());
}

async function readMountMetadata(
  sandbox: ReturnType<typeof getSandbox>,
): Promise<StoredMountMetadata | null> {
  try {
    const file = await sandbox.readFile(DEFAULT_METADATA_FILE);
    return parseMetadataFile(file.content);
  } catch (error) {
    if (error instanceof UserError) throw error;
    return null;
  }
}

async function requireMountMetadata(
  sandbox: ReturnType<typeof getSandbox>,
): Promise<StoredMountMetadata> {
  const metadata = await readMountMetadata(sandbox);
  if (metadata === null) {
    throw new UserError("No mounted repo metadata found for this sandbox", 404);
  }
  return metadata;
}

function compareMountMetadata(
  existing: StoredMountMetadata | null,
  requested: Pick<MountConfig, "remote" | "branch" | "repoName" | "mountPath">,
): string | null {
  if (existing === null) return null;
  if (existing.remote !== requested.remote) {
    return `Sandbox is mounted for ${existing.remote}, not ${requested.remote}`;
  }
  if (existing.branch !== requested.branch) {
    return `Sandbox is mounted for branch ${existing.branch}, not ${requested.branch}`;
  }
  if (existing.repoName !== requested.repoName || existing.mountPath !== requested.mountPath) {
    return "Sandbox metadata does not match the requested mount layout";
  }
  return null;
}

function parseMetadataFile(content: string): StoredMountMetadata {
  const values = new Map<string, string>();
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    values.set(line.slice(0, index), line.slice(index + 1).trim());
  }

  const remote = values.get("MOUNTED_REMOTE");
  const branch = values.get("MOUNTED_BRANCH");
  const repoName = values.get("MOUNTED_REPO_NAME");
  const mountPath = values.get("MOUNTED_MOUNT_PATH");
  if (remote === undefined || branch === undefined || repoName === undefined || mountPath === undefined) {
    throw new UserError("Mount metadata is missing required fields", 500);
  }
  return { remote, branch, repoName, mountPath };
}

function cleanRepoPath(value: string): string {
  const path = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "") return ".";
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UserError("path must be repo-relative and must not contain . or .. segments", 400);
  }
  return path;
}

function normalizeSandboxId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRequestedSandboxId(value: string): string {
  const normalized = normalizeSandboxId(value);
  if (normalized.length < 1 || normalized.length > 63) {
    throw new UserError("sandboxId must be 1-63 characters long", 400);
  }
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    throw new UserError("sandboxId cannot start or end with hyphens", 400);
  }
  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    throw new UserError("sandboxId may contain only letters, numbers, dots, and hyphens", 400);
  }
  if (!/[a-z0-9]/.test(normalized)) {
    throw new UserError("sandboxId must include at least one letter or number", 400);
  }
  return normalized;
}

function validateOptionalString(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "string") {
    throw new UserError(`${name} must be a string`, 400);
  }
}

function validateGitCredentials(username: string | undefined, password: string | undefined): void {
  if ((username === undefined) !== (password === undefined)) {
    throw new UserError("gitUsername and gitPassword must be provided together", 400);
  }
  if (username === "" || password === "") {
    throw new UserError("gitUsername and gitPassword must not be empty", 400);
  }
  if (username !== undefined && /[\r\n]/.test(username)) {
    throw new UserError("gitUsername must not contain newlines", 400);
  }
  if (password !== undefined && /[\r\n]/.test(password)) {
    throw new UserError("gitPassword must not contain newlines", 400);
  }
}

function removeUndefinedValues(input: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function validateBranch(branch: string): void {
  const invalidBase =
    branch === "" ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\x00-\x20~^:?*[\\]/.test(branch);
  if (invalidBase) {
    throw new UserError("branch must be a valid Git branch name", 400);
  }
  for (const component of branch.split("/")) {
    if (component === "" || component.startsWith(".") || component.endsWith(".lock")) {
      throw new UserError("branch must be a valid Git branch name", 400);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function runChecked(
  sandbox: ReturnType<typeof getSandbox>,
  command: string,
  message: string,
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
) {
  const result = await sandbox.exec(command, options);
  if (!result.success) {
    throw new Response(
      JSON.stringify({
        error: message,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  return result;
}

function authorizeRequest(request: Request, env: Env): void {
  const configuredToken = env.ARTIFACTS_SANDBOX_API_TOKEN ?? "";
  if (configuredToken === "") {
    throw new UserError("ARTIFACTS_SANDBOX_API_TOKEN is not configured", 500);
  }

  const header = (request.headers.get("authorization") ?? "").trim();
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || token !== configuredToken) {
    throw new UserError("Unauthorized", 401);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof UserError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Response) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return Response.json({ error: message }, { status: 500 });
}

function helpText(): string {
  return [
    "ArtifactFS Cloudflare Sandbox service",
    "",
    "POST /mount  { sandboxId, remote, branch?, gitUsername?, gitPassword? }",
    "GET  /status?sandboxId=<id>",
    "GET  /tree?sandboxId=<id>&path=<repo-relative-dir>",
    "GET  /file?sandboxId=<id>&path=<repo-relative-file>",
    "",
    "All routes except / require Authorization: Bearer <ARTIFACTS_SANDBOX_API_TOKEN>.",
  ].join("\n");
}

class UserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
