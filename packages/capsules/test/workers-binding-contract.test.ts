import { describe, expect, it } from "vitest";
import {
  createCapsules,
} from "../src/index.js";
import { cloudflare, type ArtifactsBindingLike } from "../src/cloudflare.js";
import type {
  GitWorkspaceFactory,
  PushableGitWorkspace,
} from "../src/artifacts/workers.js";

const encoder = new TextEncoder();

describe("Cloudflare adapter", () => {
  it("creates a repo, strips token expiry metadata, and never returns tokens in refs", async () => {
    const opened: Array<{
      remote: string;
      branch: string;
      isNew: boolean;
      password: string;
    }> = [];
    const workspace = fakeWorkspace();
    const gitWorkspaceFactory: GitWorkspaceFactory = {
      async open(input) {
        opened.push({
          remote: input.remote,
          branch: input.branch,
          isNew: input.isNew,
          password: input.auth.password,
        });
        return workspace;
      },
    };
    const binding: ArtifactsBindingLike = {
      async get() {
        throw new Error("not found");
      },
      async create(name, opts) {
        return {
          name,
          remote: `https://example.com/${name}.git`,
          ...(opts?.setDefaultBranch !== undefined
            ? { defaultBranch: opts.setDefaultBranch }
            : {}),
          token: "art_v1_secret?expires=9999999999",
        };
      },
    };

    const capsules = createCapsules({
      adapter: cloudflare(binding, { gitWorkspaceFactory }),
    });
    const refs = await capsules.capture({
      workflow: { workflowName: "ResearchWorkflow", instanceId: "research-001" },
      step: { step: { name: "create ai response", count: 1 }, attempt: 1 },
      name: "ai-response",
      input: { prompt: "hi" },
      run: async ({ files, effects }) => {
        await files.write("output/answer.md", "hello", { exposeAs: "answer" });
        await effects.record("cloudflare-ai.run", { externalId: "run_123" });
        return { answerPath: "output/answer.md" };
      },
    });

    expect(opened).toEqual([
      {
        remote: `https://example.com/${refs.artifact.repo}.git`,
        branch: "main",
        isNew: true,
        password: "art_v1_secret",
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("secret");
    expect(refs.artifact.adapter).toBe("cloudflare");
    expect(await workspace.readFile(refs.files.answer!.path)).toEqual(
      encoder.encode("hello"),
    );
  });
});

function fakeWorkspace(): PushableGitWorkspace {
  const files = new Map<string, Uint8Array>();
  let head: string | undefined;
  let commitNumber = 0;
  return {
    async readHead() {
      return head;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async commitAndPush(nextFiles) {
      const parent = head;
      for (const [path, bytes] of nextFiles) {
        files.set(path, bytes);
      }
      commitNumber += 1;
      head = `${String(commitNumber).padStart(40, "0")}`;
      return { commit: head, ...(parent !== undefined ? { parent } : {}) };
    },
  };
}
