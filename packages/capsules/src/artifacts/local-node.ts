import { CapsuleError } from "../core/errors.js";
import type { CommittedStep } from "../core/types.js";
import {
  SerialCommitQueue,
  type RepositorySession,
  type RepositoryStore,
} from "./tree-backend.js";

/**
 * Local Node artifact store: run repos are plain Git working trees under a
 * root directory, committed with the native `git` binary. This is used by the
 * local adapter for Node scripts, tests, and CLIs.
 *
 * The root can be a normal directory or a directory you later serve/inspect
 * with ArtifactFS (`artifact-fs daemon`); Capsule does not manage the
 * ArtifactFS daemon lifecycle itself.
 *
 * Node-only: imports `node:` modules lazily so the package entry stays
 * runtime-neutral for Workers bundlers.
 */
export type LocalNodeOptions = {
  /** Directory that holds one Git repo per Workflow run. */
  readonly mountRoot: string;
  /** Commit author. Defaults to workflow-capsules. */
  readonly author?: { readonly name: string; readonly email: string };
};

const DEFAULT_AUTHOR = {
  name: "workflow-capsules",
  email: "capsules@workflow.invalid",
};

export function localRepositoryStore(options: LocalNodeOptions): RepositoryStore {
  const author = options.author ?? DEFAULT_AUTHOR;
  const repositories = new Map<string, Promise<RepositorySession>>();

  return {
    kind: "local-node",

    openRepository(name, init) {
      let pending = repositories.get(name);
      if (pending === undefined) {
        pending = openLocalRepository(name, init).catch((error) => {
          repositories.delete(name);
          throw error;
        });
        repositories.set(name, pending);
      }
      return pending;
    },
  };

  async function openLocalRepository(
    name: string,
    init: {
      readonly branch: string;
      readonly initFiles: ReadonlyMap<string, Uint8Array>;
      readonly initMessage: string;
    },
  ): Promise<RepositorySession> {
    const [fs, path, { execFile }, { promisify }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:child_process"),
      import("node:util"),
    ]);
    const exec = promisify(execFile);
    const repositoryDir = path.join(options.mountRoot, name);

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
        throw new CapsuleError(
          "BACKEND_WRITE_FAILED",
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
      await runGit("init", "-b", init.branch);
    }
    if ((await readHeadCommit()) === undefined) {
      await writeWorkingTreeFiles(init.initFiles);
      await runGit("add", "-A");
      await runGit("commit", "-m", init.initMessage);
    }

    const commitQueue = new SerialCommitQueue();
    return {
      repo: name,
      branch: init.branch,
      readHead: readHeadCommit,

      async readFile(repoPath: string): Promise<Uint8Array | null> {
        try {
          const data = await fs.readFile(path.join(repositoryDir, repoPath));
          return new Uint8Array(data);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new CapsuleError(
            "BACKEND_WRITE_FAILED",
            `Could not read ${repoPath} from local capsule repo ${repositoryDir}: ${String(cause)}. ` +
              `Committed history is intact; check local filesystem permissions and retry.`,
            { cause },
          );
        }
      },

      commitFiles(input): Promise<CommittedStep> {
        return commitQueue.run(async () => {
          const parent = await readHeadCommit();
          await writeWorkingTreeFiles(input.files);
          await runGit("add", "-A", "--", ...input.files.keys());
          await runGit("commit", "-m", input.message);
          const commit = await runGit("rev-parse", "HEAD");
          return {
            commit,
            ...(parent !== undefined ? { parent } : {}),
          };
        });
      },

      async findCommitForPath(repoPath: string): Promise<CommittedStep | undefined> {
        try {
          const logOutput = await runGit(
            "log",
            "-n",
            "1",
            "--format=%H %P",
            "--",
            repoPath,
          );
          if (logOutput === "") return undefined;
          const [commit, parent] = logOutput.split(/\s+/);
          if (commit === undefined) return undefined;
          return {
            commit,
            ...(parent !== undefined && parent !== "" ? { parent } : {}),
          };
        } catch {
          return undefined;
        }
      },
    };
  }
}
