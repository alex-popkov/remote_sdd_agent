## ADDED Requirements

### Requirement: Pipeline driver is bash

The pipeline SHALL be driven by a single bash script `pipeline/pipeline.sh`. No orchestration framework, no Node-based driver, no DAG engine. The script SHALL exit with status 0 on success, status 42 on cost-abort, and the failing stage's exit code on hard failure.

#### Scenario: Driver is a plain bash script

- **WHEN** the worker invokes the pipeline
- **THEN** it runs `bash /pipeline/pipeline.sh` and no other process orchestrates the stages

### Requirement: Stage ordering

The pipeline is **agent-based**: each stage drives one of the stack-agnostic subagents defined in `pipeline/agents/`. The pipeline SHALL execute stages in this exact order when all are enabled:

1. `task-researcher`
2. `task-planner`
3. `plan-challenge` (a fresh `task-planner` session run in critique mode; skipped when `ENABLE_PLAN_CHALLENGE` is false)
4. `task-executor`
5. `task-verifier`
6. `specification` (a `specification-from-artifacts` session; runs only when the final verdict is `PASS`)

PR creation is handled by the worker directly (see the worker-runner capability); the pipeline has no PR stage.

#### Scenario: All stages run in order on a green run

- **WHEN** a run succeeds end-to-end with all stages enabled
- **THEN** the per-stage log files in `logs/` exist with timestamps in the order above

#### Scenario: Plan-challenge can be disabled

- **WHEN** `ENABLE_PLAN_CHALLENGE` is false
- **THEN** the pipeline runs `task-researcher → task-planner → task-executor → task-verifier → specification` and produces no `plan-challenge` log

### Requirement: Each stage is a fresh Claude session

Each stage SHALL be invoked as a fresh `claude -p` session that selects the stage's subagent (e.g. `claude -p "<task instruction>" --agent <agent-name>`), with no session-resume flag. No conversational state SHALL be carried between stages; the only communication channel between stages is the files the agents read and write under `repo/.claude/sdd-tracking/` (and the committed `repo/.claude/specs/`).

#### Scenario: No session resumption flag is used

- **WHEN** any stage invokes `claude`
- **THEN** the command line does not include `--resume`, `--session-id`, or any equivalent flag

#### Scenario: State passes only through files

- **WHEN** stage `task-planner` needs the research output
- **THEN** it reads it from `repo/.claude/sdd-tracking/research/` and not from any shared in-memory session

### Requirement: Agents are markdown data

Agent definitions SHALL live as static markdown files in `pipeline/agents/<agent>.md`, each with frontmatter (`name`, `description`, `tools`, `model`). Agents SHALL be stack-agnostic — they discover the target repository's language, frameworks, and conventions from the repository itself (manifests, lockfiles, config) and from the repo's own `CLAUDE.md` / project skills when present, rather than assuming a fixed stack. Agent definitions SHALL NOT be generated at runtime, templated from code, or fetched over the network.

#### Scenario: Agents are static files on disk

- **WHEN** any stage runs
- **THEN** its agent definition comes from `pipeline/agents/<agent>.md` and from nowhere else

#### Scenario: Agents make no stack assumptions

- **WHEN** the pipeline runs against a repository in any language
- **THEN** no agent hardcodes a specific framework, package manager, or test runner; each derives them from the repository

### Requirement: Agent availability and artifact tree

Before the first stage, the pipeline SHALL make the agent definitions discoverable to the CLI (e.g. by copying `pipeline/agents/*.md` into `$RUN_DIR/repo/.claude/agents/` or by passing an explicit agents directory), and SHALL create the working-artifact tree `$RUN_DIR/repo/.claude/sdd-tracking/{research,plans,details,prompts,changes,verification}`. That tree SHALL be symlinked to `$ARTIFACTS_DIR` so artifacts persist in the run directory for the worker and for observability. The `.claude/sdd-tracking/` tree is a working area and SHALL remain gitignored; only `.claude/specs/` is committed.

#### Scenario: Artifact tree exists before the first stage

- **WHEN** the pipeline starts
- **THEN** `repo/.claude/sdd-tracking/` with its six subdirectories exists and is reachable via `$ARTIFACTS_DIR`

#### Scenario: Working artifacts are not committed

- **WHEN** the executor commits the implementation
- **THEN** files under `.claude/sdd-tracking/` are excluded from the commit while files under `.claude/specs/` are included

### Requirement: Single primary artifact per stage

Each stage SHALL produce at least one primary output artifact. If a stage emits multiple files, it SHALL designate one as the primary output and the pipeline SHALL only require the primary file to exist for the stage to be considered successful. Required primary artifacts per stage:

| Stage | Primary artifact |
|---|---|
| `task-researcher` | `.claude/sdd-tracking/research/*-research.md` |
| `task-planner` | `.claude/sdd-tracking/plans/*-plan.instructions.md` (with `details/*-details.md` and `prompts/implement-*.prompt.md` as secondary) |
| `plan-challenge` | the existing plan/details rewritten in place (newer mtime than the stage start) |
| `task-executor` | a non-empty git diff in `repo/` plus `.claude/sdd-tracking/changes/*-changes.md` |
| `task-verifier` | `.claude/sdd-tracking/verification/*-verification.md` whose first line is `VERDICT: PASS` or `VERDICT: FAIL` |
| `specification` | `.claude/specs/<module>/spec-*.md` plus an updated `.claude/specs/INDEX.md` |

#### Scenario: Stage success requires its primary artifact

- **WHEN** a stage exits 0 but its primary artifact does not exist
- **THEN** the pipeline treats the stage as failed and applies retry logic

#### Scenario: In-place rewrite counts as success for plan-challenge

- **WHEN** `plan-challenge` runs and the plan/details files already exist
- **THEN** the stage is considered successful only if those files have a modification time newer than the stage start (i.e. they were actually revised)

### Requirement: Per-stage retry budget

The pipeline SHALL retry each failed stage up to `MAX_STAGE_RETRIES` times (default 3) before declaring the stage hard-failed and aborting the run. The retry count SHALL be recorded in `run.json.stages[i].attempts`.

#### Scenario: Stage succeeds after one retry

- **WHEN** `task-planner` exits non-zero on attempt 1 and exits 0 on attempt 2
- **THEN** `run.json.stages` records `attempts: 2` for `task-planner` and the pipeline continues

#### Scenario: Stage exhausts retries

- **WHEN** a stage exits non-zero on all `MAX_STAGE_RETRIES` attempts
- **THEN** the pipeline exits with that stage's exit code and does not run subsequent stages

### Requirement: Working directory and environment per stage

The pipeline SHALL invoke each stage with `cwd = $RUN_DIR/repo` and SHALL export these environment variables to the stage process: `RUN_DIR`, `ARTIFACTS_DIR=$RUN_DIR/artifacts`, `LOGS_DIR=$RUN_DIR/logs`, `STAGE_NAME`, plus the flattened `TaskTrigger` fields (`TRIGGER_ID`, `ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_URL`, `ISSUE_AUTHOR`, `REPO_OWNER`, `REPO_NAME`, `TRIGGER_SOURCE`, `ACTOR`). The issue context SHALL also be passed into the agent's task instruction so the agent can act on it.

#### Scenario: Stage runs with correct cwd

- **WHEN** any stage process is forked
- **THEN** its working directory is `$RUN_DIR/repo`

#### Scenario: Required env vars are exported

- **WHEN** any stage process is forked
- **THEN** `RUN_DIR`, `ARTIFACTS_DIR`, `LOGS_DIR`, `STAGE_NAME`, `TRIGGER_ID`, and the issue/repo fields are present in its environment

### Requirement: Per-stage logging

The pipeline SHALL tee each stage's stdout and stderr to `$LOGS_DIR/<stage>.log`. Logs from prior attempts SHALL be appended (not overwritten) so retry history is preserved.

#### Scenario: Stage log captures stdout and stderr

- **WHEN** a stage runs
- **THEN** `$LOGS_DIR/<stage>.log` contains both its stdout and stderr output

#### Scenario: Retries append to the same log file

- **WHEN** a stage runs three times before succeeding
- **THEN** `$LOGS_DIR/<stage>.log` contains the output of all three attempts in order

### Requirement: Adversarial plan-challenge stage

When enabled, the `plan-challenge` stage SHALL be adversarial: a fresh `task-planner` session SHALL be instructed to find gaps, contradictions, missing requirements, and risky assumptions in the existing plan and details, and SHALL revise `*-plan.instructions.md` / `*-details.md` in place to address them. This stage is the agent-pipeline successor to the former prompt-based `challenge-spec` / `challenge-design` stages.

#### Scenario: Plan-challenge revises the plan

- **WHEN** `plan-challenge` runs
- **THEN** `.claude/sdd-tracking/plans/*-plan.instructions.md` has been rewritten (its modification time is newer than the stage start) to address gaps found in the prior plan

### Requirement: Post-implementation verification and verify→execute loop

After `task-executor`, the `task-verifier` stage SHALL independently check the implementation against the plan, details, and the issue's acceptance criteria, run the repository's own build/lint/test commands, and emit a verdict file whose first line is `VERDICT: PASS` or `VERDICT: FAIL`. When the verdict is `FAIL`, the pipeline SHALL re-run `task-executor` (feeding it the verification report) and then `task-verifier` again, up to `MAX_VERIFY_RETRIES` times (default 1). The verifier SHALL classify the failure origin so the loop can route a planning-level failure back to `task-planner` rather than only re-running `task-executor`. The final verdict SHALL be carried forward to the worker.

#### Scenario: Verdict is machine-readable

- **WHEN** `task-verifier` completes
- **THEN** the first line of its verification artifact is exactly `VERDICT: PASS` or `VERDICT: FAIL`

#### Scenario: Failing verdict triggers a bounded re-execution

- **WHEN** `task-verifier` returns `VERDICT: FAIL` and `MAX_VERIFY_RETRIES` is 1
- **THEN** `task-executor` runs once more with the verification report, `task-verifier` runs again, and the second verdict is final

#### Scenario: Persistent failure is carried forward, not hidden

- **WHEN** the verdict is still `FAIL` after `MAX_VERIFY_RETRIES` re-executions
- **THEN** the pipeline records the final `FAIL` verdict and the worker opens the PR as a draft (see the worker-runner capability)

### Requirement: Specification stage gated on PASS

The `specification` stage SHALL run only when the final verdict is `PASS`. It SHALL invoke `specification-from-artifacts` to distill the pipeline artifacts into a permanent specification committed under `.claude/specs/`, and SHALL update `.claude/specs/INDEX.md`. When the final verdict is `FAIL`, the pipeline SHALL skip the specification stage.

#### Scenario: Spec is produced on a green run

- **WHEN** the final verdict is `PASS`
- **THEN** a `.claude/specs/<module>/spec-*.md` file exists and `.claude/specs/INDEX.md` references it

#### Scenario: Spec is skipped on a failing run

- **WHEN** the final verdict is `FAIL`
- **THEN** no specification stage runs and no new file under `.claude/specs/` is produced for this run
