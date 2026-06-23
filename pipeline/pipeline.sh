#!/usr/bin/env bash
#
# SDD agent pipeline (M6: full agent pipeline — challenge + specification).
#
# Drives a sequence of stack-agnostic subagents (pipeline/agents/*.md), each in
# a fresh `claude -p` session, communicating only through files under
# repo/.claude/sdd-tracking/ (and the committed repo/.claude/specs/). No
# orchestration framework — just bash.
#
#   task-researcher -> task-planner -> plan-challenge -> task-executor -> task-verifier -> specification
#                                       (best-effort)        ^                  |            (on PASS,
#                                                            +-- verify loop ---+             best-effort)
#                                                                (on FAIL verdict)
#
# Inputs (exported by the worker; see worker/src/pipeline.ts):
#   RUN_DIR           absolute path to workspace/runs/<triggerId>
#   ISSUE_NUMBER ISSUE_TITLE ISSUE_BODY ISSUE_URL ISSUE_AUTHOR
#   REPO_OWNER REPO_NAME TRIGGER_SOURCE ACTOR TRIGGER_ID
#   ANTHROPIC_API_KEY
# Optional:
#   MAX_STAGE_RETRIES     (default 3)     per-stage retry budget
#   MAX_VERIFY_RETRIES    (default 1)     executor<->verifier re-runs on FAIL
#   ENABLE_PLAN_CHALLENGE (default true)  run the adversarial plan-challenge pass
#   AGENTS_DIR            (default <script dir>/agents)
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

  # The permanent spec the `specification` stage writes (M6). Unlike
  # sdd-tracking/ this is COMMITTED and part of the PR diff, so it is created
  # here but deliberately NOT added to .git/info/exclude below.
  mkdir -p "$REPO_DIR/.claude/specs"

  # Keep agent definitions and working artifacts out of the PR diff without
  # touching the target repo's tracked .gitignore (local, uncommitted exclude).
  # .claude/specs/ is intentionally absent here so the spec lands in the PR.
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
    plan-challenge)
      printf '%s\n%s' "$header" \
"Critically review the existing implementation plan in .claude/sdd-tracking/{plans,details}/ for this issue, acting as an adversarial reviewer. Find gaps, contradictions, missing requirements, ambiguous steps, missing edge cases, and risky assumptions, then REVISE the existing *-plan.instructions.md and *-details.md files IN PLACE to address them. Keep the implementation prompt (implement-*.prompt.md) structure intact — refine, do not rewrite from scratch. Do not create new files and do not write source code. If the plan is already sound, make no changes." ;;
    specification)
      printf '%s\n%s' "$header" \
"The implementation passed verification. Using all artifacts under .claude/sdd-tracking/ (research, plans, details, changes), distill a permanent specification: write .claude/specs/<module>/<spec-name>.md and update .claude/specs/INDEX.md to reference it. Act autonomously — do NOT ask any questions; if a related spec already exists, update it, otherwise create a new one. Write the spec and the INDEX only; do not modify source code." ;;
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
  # <stage-label> selects the task instruction + log name; <agent-name> selects
  # the subagent. They differ for plan-challenge, which runs --agent task-planner
  # under its own stage label.
  local stage="$1" agent="$2"
  local instruction
  instruction="$(stage_instruction "$stage")"
  ( cd "$REPO_DIR" && claude -p "$instruction" \
      --agent "$agent" \
      --permission-mode bypassPermissions )
}

# --- 5.1 / 5.2 run_stage with retry + artifact check -------------------------

# run_stage <stage-label> <artifact-dir> <artifact-name-glob> [agent-name]
# Success = a file matching the glob exists in <artifact-dir> AND is newer than
# the stage start (so an in-place rewrite also counts — used by M6).
# <agent-name> defaults to <stage-label> when omitted.
run_stage() {
  local stage="$1" dir="$2" pattern="$3" agent="${4:-$1}"
  export STAGE_NAME="$stage"
  local logfile="$LOGS_DIR/$stage.log"
  local marker="$LOGS_DIR/.$stage.start"
  local attempt=1

  while [ "$attempt" -le "$MAX_STAGE_RETRIES" ]; do
    log "stage $stage (attempt $attempt/$MAX_STAGE_RETRIES)"
    : > "$marker"   # marker mtime == stage start
    {
      echo "=== $stage attempt $attempt ==="
      invoke_agent "$stage" "$agent" 2>&1 || echo "[pipeline] $stage exited non-zero"
    } >> "$logfile" 2>&1

    if find "$dir" -type f -name "$pattern" -newer "$marker" 2>/dev/null | grep -q .; then
      rm -f "$marker"
      log "stage $stage ok"
      return 0
    fi
    attempt=$((attempt + 1))
  done

  rm -f "$marker"
  log "stage $stage FAILED: no '$pattern' in $dir after $MAX_STAGE_RETRIES attempts"
  return 1
}

# --- 6.2 plan-challenge: best-effort in-place plan revision -------------------

# Single attempt, never fails the run: an adversarial task-planner session that
# rewrites the plan/details in place. A sound plan legitimately yields no edits,
# so "no changes" is a normal outcome, not a failure.
run_plan_challenge() {
  export STAGE_NAME="plan-challenge"
  local marker="$LOGS_DIR/.plan-challenge.start"
  : > "$marker"
  log "stage plan-challenge (revise plan in place)"
  {
    echo "=== plan-challenge ==="
    invoke_agent "plan-challenge" "task-planner" 2>&1 \
      || echo "[pipeline] plan-challenge exited non-zero"
  } >> "$LOGS_DIR/plan-challenge.log" 2>&1

  if find "$SDD_DIR/plans" "$SDD_DIR/details" -type f -newer "$marker" 2>/dev/null | grep -q .; then
    log "plan-challenge ok — plan revised"
  else
    log "plan-challenge — no changes, proceeding"
  fi
  rm -f "$marker"
}

# --- 6.3 specification: best-effort permanent spec on PASS -------------------

# Runs only on a PASS verdict. Best-effort: a spec hiccup must not discard a
# verified implementation, so a failure here is logged and the pipeline still
# returns success. Success is keyed on .claude/specs/INDEX.md being updated
# (the agent always maintains it; individual spec filenames vary).
run_specification() {
  export STAGE_NAME="specification"
  local specs_dir="$REPO_DIR/.claude/specs"
  local marker="$LOGS_DIR/.specification.start"
  : > "$marker"
  log "stage specification (write permanent spec)"
  {
    echo "=== specification ==="
    invoke_agent "specification" "specification-from-artifacts" 2>&1 \
      || echo "[pipeline] specification exited non-zero"
  } >> "$LOGS_DIR/specification.log" 2>&1

  if find "$specs_dir" -type f \( -name 'INDEX.md' -o -name '*.md' \) -newer "$marker" 2>/dev/null | grep -q .; then
    log "specification ok — spec written under .claude/specs/"
  else
    log "specification — produced no spec (best-effort, proceeding)"
  fi
  rm -f "$marker"
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

  # 6.1 adversarial plan-challenge (best-effort), gated by ENABLE_PLAN_CHALLENGE.
  if [ "${ENABLE_PLAN_CHALLENGE:-true}" != "false" ]; then
    run_plan_challenge
  else
    log "plan-challenge disabled (ENABLE_PLAN_CHALLENGE=false)"
  fi

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

  # 6.3 specification stage — only on PASS, best-effort (never sinks a verified
  # run). The core-stage hard-fails above already aborted on real failures.
  if [ "$verdict" = PASS ]; then
    run_specification
  else
    log "verdict FAIL — skipping specification stage"
  fi

  return 0
}

main "$@"
