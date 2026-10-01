#!/usr/bin/env bash
# Local smoke test for the receiver — no GitHub, no tunnel required.
#
# Exercises the receiver → file-queue pipe. The positive cases enqueue real
# tasks for a whitelisted repo, so the worker is paused (docker compose pause)
# for the duration and every task the smoke test enqueued is deleted on exit —
# otherwise the worker would run the full pipeline and open real PRs.
#
#   1. /health is up
#   2. signed label-trigger payload → 202 + file appears in pending/
#   3. wrong signature                 → 401
#   4. non-whitelisted repo            → 204
#   5. [bot] sender                    → 204
#   6. issue_comment with @bot mention from a COLLABORATOR → 202 (mention trigger)
#   7. issue_comment with @bot mention from an untrusted author → 204
#
# Run with:  bash scripts/smoke-test.sh
# Requires:  docker compose up running, .env populated, openssl on PATH.
# Note: pausing freezes an in-flight pipeline run for a few seconds; it resumes
# on unpause.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found at $ROOT/.env" >&2
  exit 2
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

: "${GITHUB_WEBHOOK_SECRET:?GITHUB_WEBHOOK_SECRET not set in .env}"
: "${ALLOWED_REPOS:?ALLOWED_REPOS not set in .env}"

# Use the first whitelisted repo for the positive cases.
ALLOWED_FIRST="${ALLOWED_REPOS%%,*}"
ALLOWED_OWNER="${ALLOWED_FIRST%%/*}"
ALLOWED_NAME="${ALLOWED_FIRST##*/}"
TRIGGER_LABEL_EFFECTIVE="${TRIGGER_LABEL:-agent:run}"
BOT_MENTION_EFFECTIVE="${BOT_MENTION:-remote-agent}"

RECEIVER_URL="${RECEIVER_URL:-http://localhost:3000}"

pass=0
fail=0

PENDING_DIR="$ROOT/workspace/queue/pending"
# triggerIds the receiver returned for our 202 cases — deleted on exit.
SMOKE_IDS=()
WORKER_PAUSED=0

cleanup() {
  local id
  for id in ${SMOKE_IDS[@]+"${SMOKE_IDS[@]}"}; do
    rm -f "$PENDING_DIR/$id.json"
  done
  if [[ "$WORKER_PAUSED" == "1" ]]; then
    docker compose unpause worker >/dev/null 2>&1 \
      || echo "WARNING: failed to unpause worker — run: docker compose unpause worker" >&2
  fi
}
trap cleanup EXIT

# Compute X-Hub-Signature-256 over $1.
sign() {
  printf '%s' "$1" \
    | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" \
    | awk '{print "sha256="$2}'
}

# Args: name expected_status event_header body [signature_override] [delivery_id]
check() {
  local name="$1" expected="$2" event="$3" body="$4" sig_override="${5:-}" delivery="${6:-smoke-$RANDOM-$$}"
  local sig
  if [[ -n "$sig_override" ]]; then
    sig="$sig_override"
  else
    sig="$(sign "$body")"
  fi
  local actual
  actual=$(curl -s -o /tmp/smoke-body.$$ -w '%{http_code}' \
    -X POST "$RECEIVER_URL/webhook" \
    -H 'Content-Type: application/json' \
    -H "X-GitHub-Event: $event" \
    -H "X-GitHub-Delivery: $delivery" \
    -H "X-Hub-Signature-256: $sig" \
    --data "$body")
  if [[ "$actual" == "202" ]]; then
    local id
    id=$(sed -n 's/.*"triggerId":"\([^"]*\)".*/\1/p' /tmp/smoke-body.$$)
    [[ -n "$id" ]] && SMOKE_IDS+=("$id")
  fi
  if [[ "$actual" == "$expected" ]]; then
    printf '  \e[32mPASS\e[0m  %s  (got %s)\n' "$name" "$actual"
    pass=$((pass+1))
  else
    printf '  \e[31mFAIL\e[0m  %s  (expected %s, got %s)\n' "$name" "$expected" "$actual"
    printf '        body: %s\n' "$(cat /tmp/smoke-body.$$)"
    fail=$((fail+1))
  fi
  rm -f /tmp/smoke-body.$$
}

echo "==> Health check"
hc=$(curl -s -o /dev/null -w '%{http_code}' "$RECEIVER_URL/health" || true)
if [[ "$hc" == "200" ]]; then
  printf '  \e[32mPASS\e[0m  GET /health  (got 200)\n'
  pass=$((pass+1))
else
  printf '  \e[31mFAIL\e[0m  GET /health  (got %s — is `docker compose up` running?)\n' "$hc"
  fail=$((fail+1))
  exit 1
fi

# Freeze the worker so it can't claim the tasks we enqueue before cleanup.
if docker compose pause worker >/dev/null 2>&1; then
  WORKER_PAUSED=1
else
  echo "ERROR: could not pause the worker (docker compose pause worker)." >&2
  echo "       Refusing to run: positive cases would trigger real pipeline runs and PRs." >&2
  exit 2
fi

echo "==> Webhook cases"

# 1) Positive: issues.labeled with TRIGGER_LABEL on a whitelisted repo → 202
body_label=$(cat <<JSON
{"action":"labeled","repository":{"name":"$ALLOWED_NAME","owner":{"login":"$ALLOWED_OWNER"},"full_name":"$ALLOWED_FIRST"},"issue":{"number":1,"title":"smoke","body":"smoke test","html_url":"https://example/x","user":{"login":"alice"}},"label":{"name":"$TRIGGER_LABEL_EFFECTIVE"},"sender":{"login":"alice"}}
JSON
)
check "label trigger on whitelisted repo" 202 issues "$body_label"

# 2) Negative: bad signature → 401
check "invalid signature is rejected" 401 issues "$body_label" "sha256=deadbeef"

# 3) Negative: non-whitelisted repo → 204
body_otherrepo=$(cat <<JSON
{"action":"labeled","repository":{"name":"evil","owner":{"login":"attacker"},"full_name":"attacker/evil"},"issue":{"number":1,"title":"x","body":"y","html_url":"https://x","user":{"login":"a"}},"label":{"name":"$TRIGGER_LABEL_EFFECTIVE"},"sender":{"login":"a"}}
JSON
)
check "non-whitelisted repo is dropped" 204 issues "$body_otherrepo"

# 4) Negative: [bot] sender → 204
body_bot=$(cat <<JSON
{"action":"labeled","repository":{"name":"$ALLOWED_NAME","owner":{"login":"$ALLOWED_OWNER"},"full_name":"$ALLOWED_FIRST"},"issue":{"number":1,"title":"x","body":"y","html_url":"https://x","user":{"login":"a"}},"label":{"name":"$TRIGGER_LABEL_EFFECTIVE"},"sender":{"login":"remote-agent[bot]"}}
JSON
)
check "[bot] sender is dropped" 204 issues "$body_bot"

# 5) Positive: issue_comment.created with @<BOT_MENTION> from a trusted author → 202
body_mention=$(cat <<JSON
{"action":"created","repository":{"name":"$ALLOWED_NAME","owner":{"login":"$ALLOWED_OWNER"},"full_name":"$ALLOWED_FIRST"},"issue":{"number":2,"title":"smoke","body":"y","html_url":"https://x","user":{"login":"alice"}},"comment":{"body":"hey @$BOT_MENTION_EFFECTIVE please look","user":{"login":"alice"},"author_association":"COLLABORATOR"},"sender":{"login":"alice"}}
JSON
)
check "mention trigger from comment" 202 issue_comment "$body_mention"

# 6) Negative: same mention from an untrusted author (author_association NONE) → 204
body_mention_untrusted=$(cat <<JSON
{"action":"created","repository":{"name":"$ALLOWED_NAME","owner":{"login":"$ALLOWED_OWNER"},"full_name":"$ALLOWED_FIRST"},"issue":{"number":2,"title":"smoke","body":"y","html_url":"https://x","user":{"login":"alice"}},"comment":{"body":"hey @$BOT_MENTION_EFFECTIVE please look","user":{"login":"mallory"},"author_association":"NONE"},"sender":{"login":"mallory"}}
JSON
)
check "mention from untrusted author is dropped" 204 issue_comment "$body_mention_untrusted"

echo "==> Queue state"
if [[ ${#SMOKE_IDS[@]} -ne 2 ]]; then
  printf '  \e[31mFAIL\e[0m  expected 2 triggerIds from positive cases, got %s\n' "${#SMOKE_IDS[@]}"
  fail=$((fail+1))
fi
for id in ${SMOKE_IDS[@]+"${SMOKE_IDS[@]}"}; do
  if [[ -f "$PENDING_DIR/$id.json" ]]; then
    printf '  \e[32mPASS\e[0m  %s landed in pending/ (removed on exit)\n' "$id"
    pass=$((pass+1))
  else
    printf '  \e[31mFAIL\e[0m  %s not found in pending/\n' "$id"
    fail=$((fail+1))
  fi
done

echo
echo "==> Summary"
printf '  passed: %s\n  failed: %s\n' "$pass" "$fail"
exit "$fail"
