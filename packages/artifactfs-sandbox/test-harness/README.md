# Capsules Sandbox Harness

Runs the `workflow-capsules` Cloudflare example and clones the generated capsule repo into `packages/artifactfs-sandbox/workflow-run-repos/`.

Local package test:

```sh
cd packages/artifactfs-sandbox
./test-harness/run-local-capsules.sh
```

Inspect cloned capsule repos:

```sh
pnpm capsules:logs
pnpm capsules:logs <repo-name-or-instance-id>
pnpm capsules:logs <repo-name-or-instance-id> --step 1
pnpm capsules:logs <repo-name-or-instance-id> --step "charge customer"
pnpm capsules:logs <repo-name-or-instance-id> --call stripe.invoice.create
pnpm capsules:logs <repo-name-or-instance-id> --files
pnpm capsules:logs <repo-name-or-instance-id> --step 1 --json
```

Generate idempotency behaviour runs:

```sh
pnpm capsules:demo
```

Cloudflare Workflow test:

```sh
cd packages/artifactfs-sandbox
./test-harness/run-capsules-workflow.sh
```

The script uses:

- `test-harness/stripe-mock`: Stripe-shaped Worker used by the Workflow payload.
- `test-harness/artifacts-inspector`: Worker bound to the same Artifacts namespace that returns the run repo remote plus a short-lived read token.
- the deployed ArtifactFS sandbox Worker to mount and inspect the generated capsule repo.

The cloned run repo is ignored by git.
