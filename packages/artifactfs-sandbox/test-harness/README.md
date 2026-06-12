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
