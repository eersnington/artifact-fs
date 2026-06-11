#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SANDBOX_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
CAPSULES_DIR=$(cd "${SANDBOX_DIR}/../capsules" && pwd)

(
  cd "$CAPSULES_DIR"
  pnpm install --frozen-lockfile
  pnpm run build
)

node "${SCRIPT_DIR}/idempotency-workflows.mjs"

echo
echo "Generated workflow runs:"
node "${SCRIPT_DIR}/inspect-capsules.mjs"
