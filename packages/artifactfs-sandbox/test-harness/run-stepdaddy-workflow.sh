#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SANDBOX_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
REPO_ROOT=$(cd "${SANDBOX_DIR}/../.." && pwd)
WORKFLOW_DIR="${REPO_ROOT}/examples/workflow-stepdaddy-mvp"
RUN_REPOS_DIR="${SANDBOX_DIR}/workflow-run-repos"
SANDBOX_URL=${SANDBOX_URL:-https://artifact-fs-sandbox.sreeaadhi07.workers.dev}

if [ -f "${SANDBOX_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${SANDBOX_DIR}/.env"
  set +a
fi

ensure_env_file_line() {
  local key="$1"
  local value="$2"
  umask 077
  if [ ! -f "${SANDBOX_DIR}/.env" ] || ! grep -q "^${key}=" "${SANDBOX_DIR}/.env"; then
    printf '%s=%s\n' "$key" "$value" >>"${SANDBOX_DIR}/.env"
  fi
}

json_field() {
  local field="$1"
  node -e 'const field = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const value = JSON.parse(input)[field]; if (value !== undefined && value !== null) process.stdout.write(String(value)); });' "$field"
}

extract_worker_url() {
  node -e 'let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const match = input.match(/https:\/\/[^\s]+\.workers\.dev/); if (!match) process.exit(1); process.stdout.write(match[0]); });'
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]));' "$1"
}

repo_name_for_run() {
  WORKFLOW_NAME="$1" WORKFLOW_INSTANCE_ID="$2" node <<'NODE'
const crypto = require("node:crypto");
const workflowName = process.env.WORKFLOW_NAME;
const instanceId = process.env.WORKFLOW_INSTANCE_ID;
const clean = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
const workflow = clean(workflowName);
const instance = clean(instanceId);
let repoName = `stepdaddy-${workflow}-${instance}`;
if (repoName.length > 100) {
  const repoHash = crypto.createHash("sha256")
    .update(JSON.stringify({ workflowName, instanceId }))
    .digest("hex");
  const suffix = repoHash.slice(0, 8);
  const budget = 100 - "stepdaddy-".length - suffix.length - 2;
  const workflowBudget = Math.ceil(budget / 2);
  const instanceBudget = budget - workflowBudget;
  repoName = `stepdaddy-${workflow.slice(0, workflowBudget)}-${instance.slice(0, instanceBudget)}-${suffix}`;
}
process.stdout.write(repoName);
NODE
}

status_state() {
  node <<'NODE'
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const body = JSON.parse(input);
  const status = body.status;
  if (typeof status === "string") return process.stdout.write(status);
  if (status && typeof status.status === "string") return process.stdout.write(status.status);
  if (status && typeof status.state === "string") return process.stdout.write(status.state);
});
NODE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command git
require_command node
require_command openssl
require_command pnpm

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(node -e 'const fs = require("node:fs"); const text = fs.readFileSync(process.argv[1], "utf8").replace(/\/\/.*$/mg, ""); const config = JSON.parse(text); process.stdout.write(config.account_id ?? "");' "${SANDBOX_DIR}/wrangler.jsonc")
  export CLOUDFLARE_ACCOUNT_ID
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is required" >&2
  exit 1
fi

if [ -z "${ARTIFACTS_SANDBOX_API_TOKEN:-}" ]; then
  ARTIFACTS_SANDBOX_API_TOKEN=$(openssl rand -hex 32)
  export ARTIFACTS_SANDBOX_API_TOKEN
  ensure_env_file_line ARTIFACTS_SANDBOX_API_TOKEN "$ARTIFACTS_SANDBOX_API_TOKEN"
  printf '%s' "$ARTIFACTS_SANDBOX_API_TOKEN" | pnpx wrangler secret put ARTIFACTS_SANDBOX_API_TOKEN --config "${SANDBOX_DIR}/wrangler.jsonc"
  pnpx wrangler deploy --config "${SANDBOX_DIR}/wrangler.jsonc" --containers-rollout=none
fi

if [ -z "${ARTIFACTS_INSPECTOR_TOKEN:-}" ]; then
  ARTIFACTS_INSPECTOR_TOKEN=$(openssl rand -hex 32)
  export ARTIFACTS_INSPECTOR_TOKEN
  ensure_env_file_line ARTIFACTS_INSPECTOR_TOKEN "$ARTIFACTS_INSPECTOR_TOKEN"
fi

echo "Deploying Stripe mock Worker..."
STRIPE_MOCK_DEPLOY=$(pnpx wrangler deploy --config "${SCRIPT_DIR}/stripe-mock/wrangler.jsonc")
printf '%s\n' "$STRIPE_MOCK_DEPLOY"
STRIPE_MOCK_URL=${STRIPE_MOCK_URL:-$(printf '%s\n' "$STRIPE_MOCK_DEPLOY" | extract_worker_url)}

echo "Deploying Artifacts inspector Worker..."
printf '%s' "$ARTIFACTS_INSPECTOR_TOKEN" | pnpx wrangler secret put INSPECTOR_TOKEN --config "${SCRIPT_DIR}/artifacts-inspector/wrangler.jsonc"
INSPECTOR_DEPLOY=$(pnpx wrangler deploy --config "${SCRIPT_DIR}/artifacts-inspector/wrangler.jsonc")
printf '%s\n' "$INSPECTOR_DEPLOY"
INSPECTOR_URL=${INSPECTOR_URL:-$(printf '%s\n' "$INSPECTOR_DEPLOY" | extract_worker_url)}

echo "Deploying Stepdaddy example..."
(
  cd "$WORKFLOW_DIR"
  pnpm install --frozen-lockfile
  printf '%s' 'sk_test_stepdaddy_harness' | pnpm exec wrangler secret put STRIPE_SECRET
  pnpm exec wrangler deploy
) | tee "${RUN_REPOS_DIR}.workflow-deploy.log"
WORKFLOW_URL=${WORKFLOW_URL:-$(extract_worker_url <"${RUN_REPOS_DIR}.workflow-deploy.log")}
rm -f "${RUN_REPOS_DIR}.workflow-deploy.log"

echo "Starting Workflow against ${STRIPE_MOCK_URL}..."
START_JSON=$(curl -fsS -X POST "${WORKFLOW_URL}/charge" \
  -H 'content-type: application/json' \
  --data-binary @- <<JSON
{"customerId":"cus_capsule_harness","amount":1200,"currency":"usd","stripeBaseUrl":"${STRIPE_MOCK_URL}"}
JSON
)
printf '%s\n' "$START_JSON"
INSTANCE_ID=$(printf '%s' "$START_JSON" | json_field id)

if [ -z "$INSTANCE_ID" ]; then
  echo "Workflow start response did not include id" >&2
  exit 1
fi

STATUS_JSON=""
STATE=""
for _ in $(seq 1 60); do
  STATUS_JSON=$(curl -fsS "${WORKFLOW_URL}/status/${INSTANCE_ID}")
  STATE=$(printf '%s' "$STATUS_JSON" | status_state)
  printf 'workflow state: %s\n' "${STATE:-unknown}"
  case "$STATE" in
    complete|completed|success|succeeded|errored|error|failed|terminated)
      break
      ;;
  esac
  sleep 2
done

printf '%s\n' "$STATUS_JSON"
case "$STATE" in
  complete|completed|success|succeeded) ;;
  *)
    echo "Workflow did not complete successfully" >&2
    exit 1
    ;;
esac

WORKFLOW_NAME=${WORKFLOW_NAME:-charge-customer-workflow}
REPO_NAME=$(repo_name_for_run "$WORKFLOW_NAME" "$INSTANCE_ID")
echo "Stepdaddy repo: ${REPO_NAME}"

REPO_QUERY=$(urlencode "$REPO_NAME")
REPO_JSON=$(curl -fsS -H "authorization: Bearer ${ARTIFACTS_INSPECTOR_TOKEN}" "${INSPECTOR_URL}/repo?name=${REPO_QUERY}")
REMOTE=$(printf '%s' "$REPO_JSON" | json_field remote)
READ_TOKEN=$(printf '%s' "$REPO_JSON" | json_field token)

if [ -z "$REMOTE" ] || [ -z "$READ_TOKEN" ]; then
  echo "Inspector did not return remote and token" >&2
  exit 1
fi

SANDBOX_ID="stepdaddy-${INSTANCE_ID%%-*}"
echo "Mounting capsule repo through ArtifactFS sandbox as ${SANDBOX_ID}..."
REMOTE="$REMOTE" READ_TOKEN="$READ_TOKEN" SANDBOX_ID="$SANDBOX_ID" node <<'NODE' | curl -fsS -X POST "${SANDBOX_URL}/mount" \
  -H "authorization: Bearer ${ARTIFACTS_SANDBOX_API_TOKEN}" \
  -H 'content-type: application/json' \
  --data-binary @-
process.stdout.write(JSON.stringify({
  sandboxId: process.env.SANDBOX_ID,
  remote: process.env.REMOTE,
  branch: "main",
  gitUsername: "x",
  gitPassword: process.env.READ_TOKEN,
}));
NODE
printf '\n'

echo "Sandbox .stepd/run.json:"
curl -fsS -H "authorization: Bearer ${ARTIFACTS_SANDBOX_API_TOKEN}" \
  "${SANDBOX_URL}/file?sandboxId=${SANDBOX_ID}&path=.stepd/run.json"

echo "Sandbox .stepd/by-key:"
curl -fsS -H "authorization: Bearer ${ARTIFACTS_SANDBOX_API_TOKEN}" \
  "${SANDBOX_URL}/tree?sandboxId=${SANDBOX_ID}&path=.stepd/by-key"
printf '\n'

mkdir -p "$RUN_REPOS_DIR"
CLONE_DIR="${RUN_REPOS_DIR}/${REPO_NAME}"
rm -rf "$CLONE_DIR"

echo "Cloning capsule repo into ${CLONE_DIR}..."
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=credential.helper \
GIT_CONFIG_VALUE_0="!f() { printf '%s\n' 'username=x' 'password=${READ_TOKEN}'; }; f" \
git clone --branch main "$REMOTE" "$CLONE_DIR"

RUN_REPOS_DIR="$RUN_REPOS_DIR" REPO_NAME="$REPO_NAME" INSTANCE_ID="$INSTANCE_ID" WORKFLOW_URL="$WORKFLOW_URL" SANDBOX_ID="$SANDBOX_ID" REMOTE="$REMOTE" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const output = {
  repoName: process.env.REPO_NAME,
  instanceId: process.env.INSTANCE_ID,
  workflowUrl: process.env.WORKFLOW_URL,
  sandboxId: process.env.SANDBOX_ID,
  remote: process.env.REMOTE,
  clonedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(process.env.RUN_REPOS_DIR, "latest.json"), JSON.stringify(output, null, 2) + "\n");
NODE

echo "Cloned files:"
find "$CLONE_DIR/.stepd" -maxdepth 4 -type f | sort
echo "Latest metadata: ${RUN_REPOS_DIR}/latest.json"
