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

RUN_JSON=$(node "${SCRIPT_DIR}/local-stepdaddy-run.mjs")
printf '%s\n' "$RUN_JSON"

REPO_PATH=$(printf '%s' "$RUN_JSON" | node -e 'let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).repoPath));')

echo "Stepdaddy files:"
find "$REPO_PATH/.stepd" -maxdepth 4 -type f | sort

echo "Run record:"
cat "$REPO_PATH/.stepd/run.json"
