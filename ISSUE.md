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
  artifact-fs-example sh -lc 'TARGET=packages/wrangler/src/index.ts; stat -c "%n %s" "$TARGET"; cat "$TARGET"; git status --short --untracked-files=no "$TARGET"; artifact-fs status --name repo'
```

## Observed

ArtifactFS logs this during setup/indexing:

```text
{"level":"WARN","msg":"batch size resolution failed, files will show size 0 until hydrated","repo":"repo","error":"exit status 128"}
```

The mount succeeds and lists the repo root:

```text
artifact-fs: mounted at /mnt/repo
AGENTS.md
CLAUDE.md
README.md
packages
...
```

But the nested tracked file is reported as `0` bytes, `cat` prints no content, and `git status --short --untracked-files=no "$TARGET"` reports:

```text
packages/wrangler/src/index.ts 0
 M packages/wrangler/src/index.ts
```

## Expected

The target file should report a non-zero size and `cat "$TARGET"` should print its Git blob content.

Note: the small [`octocat/Hello-World`](https://github.com/octocat/Hello-World) repo is a poor repro because its root `README` is often prefetched/hydrated before manual checks run. For comparison, that file's expected content is:

```text
Hello World!
```

`git status --short --untracked-files=no "$TARGET"` should be clean.

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
