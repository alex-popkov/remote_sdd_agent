#!/usr/bin/env bash
#
# SDD agent pipeline (M5: minimum viable agent stages).
#
# Drives a sequence of stack-agnostic subagents (pipeline/agents/*.md), each in
# a fresh `claude -p` session, communicating only through files under
# repo/.claude/sdd-tracking/. No orchestration framework — just bash.
#
#   task-researcher -> task-planner -> task-executor -> task-verifier
#                                          ^                  |
#                                          +-- verify loop ---+  (on FAIL verdict)
#
# Inputs (exported by the worker; see worker/src/pipeline.ts):
#   RUN_DIR           absolute path to workspace/runs/<triggerId>
#   ISSUE_NUMBER ISSUE_TITLE ISSUE_BODY ISSUE_URL ISSUE_AUTHOR
#   REPO_OWNER REPO_NAME TRIGGER_SOURCE ACTOR TRIGGER_ID
#   ANTHROPIC_API_KEY
# Optional:
#   MAX_STAGE_RETRIES   (default 3)   per-stage retry budget
#   MAX_VERIFY_RETRIES  (default 1)   executor<->verifier re-runs on FAIL
#   AGENTS_DIR          (default <script dir>/agents)
#
# Exit codes: 0 = pipeline completed (verdict may be PASS or FAIL — the worker
# inspects the verification artifact); non-zero = a stage hard-failed.

set -euo pipefail

# --- 5.3 environment setup ---------------------------------------------------

: "${RUN_DIR:?RUN_DIR must be set by the worker}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="${AGENTS_DIR:-$SCRIPT_DIR/agents}"

REPO_DIR="$RUN_DIR/repo"
export ARTIFACTS_DIR="$RUN_DIR/artifacts"
export LOGS_DIR="$RUN_DIR/logs"

SDD_DIR="$REPO_DIR/.claude/sdd-tracking"
MAX_STAGE_RETRIES="${MAX_STAGE_RETRIES:-3}"
MAX_VERIFY_RETRIES="${MAX_VERIFY_RETRIES:-1}"

mkdir -p "$LOGS_DIR"

log() { echo "[pipeline] $*"; }

# --- 5.4 agent discoverability + artifact tree -------------------------------

setup_workspace() {
  # Make the agent definitions discoverable to the CLI (it auto-discovers
  # .claude/agents/ from the session CWD, which is REPO_DIR).
  mkdir -p "$REPO_DIR/.claude/agents"
  cp "$AGENTS_DIR"/*.md "$REPO_DIR/.claude/agents/"

  # Working-artifact tree the agents read/write.
  mkdir -p \
    "$SDD_DIR/research" \
    "$SDD_DIR/plans" \
    "$SDD_DIR/details" \
    "$SDD_DIR/prompts" \
    "$SDD_DIR/changes" \
    "$SDD_DIR/verification"

  # Keep agent definitions and working artifacts out of the PR diff without
  # touching the target repo's tracked .gitignore (local, uncommitted exclude).
  local exclude="$REPO_DIR/.git/info/exclude"
  if [ -f "$exclude" ]; then
    grep -qxF '.claude/agents/' "$exclude" || printf '.claude/agents/\n.claude/sdd-tracking/\n' >> "$exclude"
  fi

  # Expose the artifact tree under the run dir (symlink) so the worker and
  # observability can read it outside the repo. The worker pre-creates an empty
  # artifacts/ dir; replace it with the symlink.
  rm -rf "$ARTIFACTS_DIR"
  ln -s "$SDD_DIR" "$ARTIFACTS_DIR"
}

# --- stage task instructions -------------------------------------------------

stage_instruction() {
  local agent="$1"
  local header="GitHub issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}
"
  case "$agent" in
    task-researcher)
      printf '%s\n%s' "$header" \
"Research how to implement this issue against the current repository. Write evidence-based research notes to .claude/sdd-tracking/research/. Do not modify source code." ;;
    task-planner)
      printf '%s\n%s' "$header" \
"Using the research in .claude/sdd-tracking/research/, create an implementation plan for this issue. Write the plan checklist, details, and implementation prompt under .claude/sdd-tracking/{plans,details,prompts}/. Plan only — do not write source code." ;;
    task-executor)
      printf '%s\n%s' "$header" \
"Implement the plan. Start from the implementation prompt in .claude/sdd-tracking/prompts/ (implement-*.prompt.md) and follow it in continuous mode (do not stop between phases). Track every change in .claude/sdd-tracking/changes/. If a verification report exists under .claude/sdd-tracking/verification/ with VERDICT: FAIL, address its blocking findings first." ;;
    task-verifier)
      printf '%s\n%s' "$header" \
"Independently verify the implementation against the plan and this issue's acceptance criteria, and run the repository's own build/lint/test commands. Write a verification report to .claude/sdd-tracking/verification/ whose first line is exactly 'VERDICT: PASS' or 'VERDICT: FAIL'. Do not modify source code." ;;
    *)
      echo "unknown agent: $agent" >&2; return 1 ;;
  esac
}

# --- 5.5 stage invocation ----------------------------------------------------

invoke_agent() {
  local agent="$1"
  local instruction
  instruction="$(stage_instruction "$agent")"
  ( cd "$REPO_DIR" && claude -p "$instruction" \
      --agent "$agent" \
      --permission-mode bypassPermissions )
}

# --- 5.1 / 5.2 run_stage with retry + artifact check -------------------------

# run_stage <agent> <artifact-dir> <artifact-name-glob>
# Success = a file matching the glob exists in <artifact-dir> AND is newer than
# the stage start (so an in-place rewrite also counts — used by M6).
run_stage() {
  local agent="$1" dir="$2" pattern="$3"
  export STAGE_NAME="$agent"
  local logfile="$LOGS_DIR/$agent.log"
  local marker="$LOGS_DIR/.$agent.start"
  local attempt=1

  while [ "$attempt" -le "$MAX_STAGE_RETRIES" ]; do
    log "stage $agent (attempt $attempt/$MAX_STAGE_RETRIES)"
    : > "$marker"   # marker mtime == stage start
    {
      echo "=== $agent attempt $attempt ==="
      invoke_agent "$agent" 2>&1 || echo "[pipeline] $agent exited non-zero"
    } >> "$logfile" 2>&1

    if find "$dir" -type f -name "$pattern" -newer "$marker" 2>/dev/null | grep -q .; then
      rm -f "$marker"
      log "stage $agent ok"
      return 0
    fi
    attempt=$((attempt + 1))
  done

  rm -f "$marker"
  log "stage $agent FAILED: no '$pattern' in $dir after $MAX_STAGE_RETRIES attempts"
  return 1
}

# --- verdict helpers ---------------------------------------------------------

latest_verification() {
  ls -t "$SDD_DIR/verification"/*-verification.md 2>/dev/null | head -1
}

read_verdict() {
  local f line
  f="$(latest_verification || true)"
  [ -n "$f" ] || { echo FAIL; return; }
  # The contract is a 'VERDICT: PASS|FAIL' line. The agent is asked to put it on
  # line 1, but it sometimes prepends a markdownlint comment / blank line, so
  # scan for the first VERDICT: line instead of trusting head -1. Anchoring on
  # the token also avoids matching the word PASS/FAIL elsewhere in the prose.
  line="$(grep -m1 -iE '^[[:space:]]*VERDICT:' "$f" || true)"
  if printf '%s' "$line" | grep -qiE 'VERDICT:[[:space:]]*PASS'; then
    echo PASS
  else
    echo FAIL
  fi
}

# --- 5.10 / 5.11 main sequence ----------------------------------------------

main() {
  log "run $TRIGGER_ID — issue #$ISSUE_NUMBER ($TRIGGER_SOURCE)"
  setup_workspace

  run_stage task-researcher "$SDD_DIR/research"      '*-research.md'
  run_stage task-planner    "$SDD_DIR/plans"         '*-plan.instructions.md'
  run_stage task-executor   "$SDD_DIR/changes"       '*-changes.md'
  run_stage task-verifier   "$SDD_DIR/verification"  '*-verification.md'

  # 5.11 verify -> execute feedback loop.
  local verdict tries=0
  verdict="$(read_verdict)"
  while [ "$verdict" = FAIL ] && [ "$tries" -lt "$MAX_VERIFY_RETRIES" ]; do
    tries=$((tries + 1))
    log "verdict FAIL — re-execute ($tries/$MAX_VERIFY_RETRIES)"
    run_stage task-executor  "$SDD_DIR/changes"      '*-changes.md'
    run_stage task-verifier  "$SDD_DIR/verification" '*-verification.md'
    verdict="$(read_verdict)"
  done

  log "final verdict: $verdict"
  return 0
}

main "$@"
