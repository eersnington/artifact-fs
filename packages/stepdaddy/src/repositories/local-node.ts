import { StepdaddyError } from "../core/errors.js";
import type { CallStore, CallStoreRun, CommitResult, OpenRunInput } from "../core/types.js";

/**
 * Local Node call-history store: run repos are plain Git working trees under a
 * root directory, committed with the native `git` binary. This is used by the
 * local adapter for Node scripts, tests, and CLIs.
 *
 * The root can be a normal directory or a directory you later serve/inspect
 * with ArtifactFS (`artifact-fs daemon`); Stepdaddy does not manage the
 * ArtifactFS daemon lifecycle itself.
 *
 * Node-only: imports `node:` modules lazily so the package entry stays
 * runtime-neutral for Workers bundlers.
 */
export type LocalNodeOptions = {
  /** Directory that holds one call-history Git repo per Workflow run. */
  readonly mountRoot: string;
  /** Commit author. Defaults to stepdaddy. */
  readonly author?: { readonly name: string; readonly email: string };
};

const DEFAULT_AUTHOR = {
  name: "stepdaddy",
  email: "stepdaddy@workflow.invalid",
};

export function localCallStore(options: LocalNodeOptions): CallStore {
  const author = options.author ?? DEFAULT_AUTHOR;
  const repositories = new Map<string, Promise<CallStoreRun>>();

  return {
    kind: "local-node",

    openRun(input) {
      let pending = repositories.get(input.repoName);
      if (pending === undefined) {
        pending = openLocalRepository(input).catch((error) => {
          repositories.delete(input.repoName);
          throw error;
        });
        repositories.set(input.repoName, pending);
      }
      return pending;
    },
  };

  async function openLocalRepository(input: OpenRunInput): Promise<CallStoreRun> {
    const [fs, path, { execFile }, { promisify }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:child_process"),
      import("node:util"),
    ]);
    const exec = promisify(execFile);
    const repositoryDir = path.join(options.mountRoot, input.repoName);

    const runGit = async (...args: string[]): Promise<string> => {
      try {
        const { stdout } = await exec(
          "git",
          [
            "-c",
            `user.name=${author.name}`,
            "-c",
            `user.email=${author.email}`,
            ...args,
          ],
          { cwd: repositoryDir },
        );
        return stdout.trim();
      } catch (error) {
        const stderr =
          error !== null && typeof error === "object" && "stderr" in error
            ? String((error as { stderr: unknown }).stderr).trim()
            : "";
        throw new StepdaddyError(
          "SIDE_EFFECT_STORAGE_FAILED",
          `git ${args[0]} failed in ${repositoryDir}: ${stderr || String(error)}. ` +
            `Committed history is intact; fix the repository state and retry the step.`,
          { cause: error },
        );
      }
    };

    const writeWorkingTreeFiles = async (
      files: ReadonlyMap<string, Uint8Array>,
    ): Promise<void> => {
      for (const [repoPath, bytes] of files) {
        const target = path.join(repositoryDir, repoPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
    };

    const readHeadCommit = async (): Promise<string | undefined> => {
      try {
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
          cwd: repositoryDir,
        });
        return stdout.trim();
      } catch {
        return undefined;
      }
    };

    await fs.mkdir(repositoryDir, { recursive: true });
    const gitDirectoryExists = await fs
      .stat(path.join(repositoryDir, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!gitDirectoryExists) {
      await runGit("init", "-b", input.branch);
    }
    if ((await readHeadCommit()) === undefined) {
      await writeWorkingTreeFiles(input.initFiles);
      await runGit("add", "-A");
      await runGit("commit", "-m", input.initMessage);
    }

    let commitQueue: Promise<unknown> = Promise.resolve();
    return {
      repo: input.repoName,
      branch: input.branch,
      readHead: readHeadCommit,

      async readFile(repoPath: string): Promise<Uint8Array | null> {
        try {
          const data = await fs.readFile(path.join(repositoryDir, repoPath));
          return new Uint8Array(data);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new StepdaddyError(
            "SIDE_EFFECT_STORAGE_FAILED",
            `Could not read ${repoPath} from local call-history repo ${repositoryDir}: ${String(cause)}. ` +
              `Committed history is intact; check local filesystem permissions and retry.`,
            { cause },
          );
        }
      },

      commitFiles(commit): Promise<CommitResult> {
        const next = commitQueue.then(async () => {
          const parent = await readHeadCommit();
          await writeWorkingTreeFiles(commit.files);
          await runGit("add", "-A", "--", ...commit.files.keys());
          await runGit("commit", "-m", commit.message);
          const commitSha = await runGit("rev-parse", "HEAD");
          return {
            commit: commitSha,
            ...(parent !== undefined ? { parent } : {}),
          };
        });
        commitQueue = next.catch(() => undefined);
        return next;
      },
    };
  }
}
