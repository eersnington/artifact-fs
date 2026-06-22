#!/usr/bin/env bash
set -euo pipefail

: "${DEMO_REMOTE:=https://github.com/cloudflare/sandbox-sdk.git}"
: "${DEMO_BRANCH:=main}"
: "${DEMO_AGENTS:=2}"
: "${DEMO_SCENARIO:=edit-and-commit}"
: "${ARTIFACT_FS_ROOT:=/tmp/artifact-fs}"
: "${MOUNT_ROOT:=/workspace/mnt}"
: "${DEMO_DIR:=/tmp/rivet-artifact-demo}"
: "${DEMO_PORT:=8788}"

export ARTIFACT_FS_ROOT MOUNT_ROOT DEMO_DIR DEMO_PORT

if [ ! -e /dev/fuse ]; then
  echo "rivet-artifact: /dev/fuse is not available" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_FS_ROOT" "$MOUNT_ROOT" "$DEMO_DIR"
rm -f "$DEMO_DIR/events.jsonl"

if [ ! -f /tmp/rivet-artifact-sidecar.pid ] || ! kill -0 "$(cat /tmp/rivet-artifact-sidecar.pid 2>/dev/null)" 2>/dev/null; then
  nohup bun run --cwd /opt/rivet-artifact-demo start >/tmp/rivet-artifact-sidecar.log 2>&1 </dev/null &
  echo "$!" >/tmp/rivet-artifact-sidecar.pid
fi

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${DEMO_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if [ ! -f /tmp/artifact-fs-daemon.pid ] || ! kill -0 "$(cat /tmp/artifact-fs-daemon.pid 2>/dev/null)" 2>/dev/null; then
  nohup artifact-fs daemon --root "$MOUNT_ROOT" --controlplane rivet --rivet-url "http://127.0.0.1:${DEMO_PORT}" >/tmp/artifact-fs-daemon.log 2>&1 </dev/null &
  echo "$!" >/tmp/artifact-fs-daemon.pid
fi

export RUN_ID="run-$(date +%s)"
REQUEST=$(bun -e 'process.stdout.write(JSON.stringify({ runId: process.env.RUN_ID, remote: process.env.DEMO_REMOTE, branch: process.env.DEMO_BRANCH, agents: Number(process.env.DEMO_AGENTS || 2), scenario: process.env.DEMO_SCENARIO }))')

curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  --data "$REQUEST" \
  "http://127.0.0.1:${DEMO_PORT}/start"

printf '\nrun_id=%s\n' "$RUN_ID"
printf 'state=http://127.0.0.1:%s/state\n' "$DEMO_PORT"
