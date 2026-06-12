#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SANDBOX_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
STEPDADDY_DIR=$(cd "${SANDBOX_DIR}/../stepdaddy" && pwd)

(
  cd "$STEPDADDY_DIR"
  pnpm install --frozen-lockfile
  pnpm run build
)

node "${SCRIPT_DIR}/idempotency-workflows.mjs"

echo
echo "Generated workflow runs:"
node "${SCRIPT_DIR}/inspect-stepdaddy.mjs"
