import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function artifactStatus(repoName: string): Promise<string> {
	return run("artifact-fs", ["status", "--name", repoName]);
}

export async function gitHead(cwd: string): Promise<string> {
  return run("git", ["rev-parse", "HEAD"], cwd);
}

export async function gitCommit(cwd: string, message: string, relativePath: string): Promise<string> {
  await run("git", ["config", "user.email", "demo-agent@example.invalid"], cwd);
  await run("git", ["config", "user.name", "Rivet Artifact Demo"], cwd);
  await run("git", ["add", "--", relativePath], cwd);
  await run("git", ["commit", "-m", message], cwd);
  return gitHead(cwd);
}

export async function readMaybe(cwd: string, relativePath: string): Promise<void> {
  try {
    await run("bash", ["-lc", "test -f \"$1\" && sed -n '1,20p' \"$1\" >/dev/null", "bash", `${cwd}/${relativePath}`]);
  } catch {
    // Warmup reads are best-effort; missing manifests are fine across repos.
  }
}

export async function writeText(cwd: string, relativePath: string, content: string): Promise<void> {
  await run("bash", ["-lc", `mkdir -p "$(dirname ${quote(relativePath)})" && printf '%s\n' ${quote(content)} > ${quote(relativePath)}`], cwd);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
