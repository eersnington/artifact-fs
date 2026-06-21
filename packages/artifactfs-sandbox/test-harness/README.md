# Stepdaddy Sandbox Harness

Runs the Stepdaddy examples and materializes generated run repos under `packages/artifactfs-sandbox/workflow-run-repos/`.

Local package test:

```sh
cd packages/artifactfs-sandbox
./test-harness/run-local-stepdaddy.sh
```

Inspect cloned Stepdaddy repos:

```sh
pnpm stepdaddy:logs
pnpm stepdaddy:logs <repo-name-or-instance-id>
pnpm stepdaddy:logs <repo-name-or-instance-id> --step 1
pnpm stepdaddy:logs <repo-name-or-instance-id> --step "charge customer"
pnpm stepdaddy:logs <repo-name-or-instance-id> --call stripe.invoice.create
pnpm stepdaddy:logs <repo-name-or-instance-id> --files
pnpm stepdaddy:logs <repo-name-or-instance-id> --step 1 --json
```

Generate idempotency behaviour runs:

```sh
pnpm stepdaddy:demo
```

Cloudflare Workflow test:

```sh
cd packages/artifactfs-sandbox
./test-harness/run-stepdaddy-workflow.sh
```

The script uses:

- `test-harness/stripe-mock`: Stripe-shaped Worker used by the Workflow payload.
- `test-harness/artifacts-inspector`: Worker bound to the same Artifacts namespace that returns the run repo remote plus a short-lived read token.
- the deployed ArtifactFS sandbox Worker to mount and inspect the generated Stepdaddy repo.

The cloned run repo is ignored by git.

## Supermemory SMFS / ArtifactFS Bakeoff

This harness compares local Git clone modes with an ArtifactFS mount running in a Cloudflare Sandbox. It is intentionally a falsification harness: ArtifactFS should only survive if it materially beats clone for Git-native repo work.

Run the local clone baseline only:

```sh
cd packages/artifactfs-sandbox
pnpm smfs:bakeoff
```

Run a large-repo benchmark:

```sh
cd packages/artifactfs-sandbox
BAKEOFF_REPO="https://github.com/cloudflare/workers-sdk.git" \
BAKEOFF_BRANCH="main" \
BAKEOFF_PROFILE="large" \
BAKEOFF_CLONE_MODES="shallow,shallow-blobless,blobless,full" \
pnpm smfs:bakeoff
```

Run the Cloudflare ArtifactFS benchmark too:

```sh
cd packages/artifactfs-sandbox
ARTIFACTFS_SANDBOX_URL="https://<your-artifacts-sandbox-worker>" \
ARTIFACTS_SANDBOX_API_TOKEN="<token>" \
pnpm smfs:bakeoff
```

Useful environment variables:

- `BAKEOFF_REPO`: Git remote to test. Defaults to `https://github.com/supermemoryai/smfs.git`.
- `BAKEOFF_BRANCH`: branch to test. Defaults to `main`.
- `BAKEOFF_PROFILE`: `smfs` or `large`. Defaults to `smfs` for the SMFS repo and `large` otherwise.
- `BAKEOFF_CLONE_MODES`: comma-separated clone modes. Supports `shallow`, `shallow-blobless`, `blobless`, and `full`.
- `BAKEOFF_COMMAND_TIMEOUT_MS`: timeout for local commands. Defaults to 10 minutes.
- `BAKEOFF_MOUNT_TIMEOUT_MS`: timeout for async ArtifactFS mount polling. Defaults to 20 minutes.
- `BAKEOFF_SKIP_LOCAL`: set to `1` to rerun only the Cloudflare ArtifactFS side.

The Cloudflare worker must expose `POST /mount` and `POST /benchmark`. The workbench at `/Users/eers/Development/stepdaddy/workbench/artifacts-sandbox` has those routes.

Outputs are written to `.bakeoff/smfs-artifactfs/` at the repository root and are ignored by git.
