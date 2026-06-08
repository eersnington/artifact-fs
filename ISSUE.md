# Blobless files appear empty after size-resolution warning

## Repro

Environment:

```text
macOS 26.5.1 arm64
Docker Desktop 4.42.0
Docker engine 28.2.2, linux/arm64, kernel 6.10.14-linuxkit
ArtifactFS revision 083e55e
```

Commands:

```bash
docker build -t artifact-fs-example -f examples/Dockerfile .

docker run --rm --cap-add SYS_ADMIN --device /dev/fuse \
  -e REPO_REMOTE_URL=https://github.com/octocat/Hello-World.git \
  -e REPO_BRANCH=master \
  artifact-fs-example sh -lc 'cat README; git status --short --untracked-files=no; artifact-fs status --name repo'
```

## Observed

ArtifactFS logs this during setup/indexing:

```text
{"level":"WARN","msg":"batch size resolution failed, files will show size 0 until hydrated","repo":"repo","error":"exit status 128"}
```

The mount succeeds and lists the tracked file:

```text
artifact-fs: mounted at /mnt/repo
README
```

But `cat README` prints no content, and `git status --short --untracked-files=no` reports:

```text
 M README
```

With a larger repository like [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk), the same symptom appeared as many tracked files reported modified by `git status`.

## Expected

`cat README` should print:

```text
Hello World!
```

`git status --short --untracked-files=no` should be clean.

## Likely Area To Inspect

The warning comes from:

```text
internal/gitstore/gitstore.go: BuildTreeIndex -> batchResolveSizes
```

Potentially related paths:

```text
internal/model/types.go: BaseNode.SizeState, BaseNode.SizeBytes
internal/fusefs/merged.go: Resolver.Getattr
internal/fusefs/fuse_unix.go: LookUpInode, GetInodeAttributes, ReadFile
internal/fusefs/ops.go: Engine.Read
internal/hydrator/hydrator.go: EnsureHydrated
```

Hypothesis to verify: after `batchResolveSizes` fails, unknown-size files may be exposed through FUSE as `0` bytes before read-time hydration fetches the blob.
