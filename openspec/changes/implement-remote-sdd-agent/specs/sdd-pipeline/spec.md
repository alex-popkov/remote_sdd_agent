## ADDED Requirements

### Requirement: Pipeline driver is bash

The pipeline SHALL be driven by a single bash script `pipeline/pipeline.sh`. No orchestration framework, no Node-based driver, no DAG engine. The script SHALL exit with status 0 on success, status 42 on cost-abort, and the failing stage's exit code on hard failure.

#### Scenario: Driver is a plain bash script

- **WHEN** the worker invokes the pipeline
- **THEN** it runs `bash /pipeline/pipeline.sh` and no other process orchestrates the stages

### Requirement: Stage ordering

The pipeline SHALL execute stages in this exact order when all are enabled:

1. `01-parse`
2. `02-spec`
3. `03-challenge-spec`
4. `04-design`
5. `05-challenge-design`
6. `06-tasks`
7. `07-implement`
8. `08-verify`
9. `09-pr`

Stage `09-pr` MAY be a no-op if the worker handles PR creation directly; in that case the worker remains responsible.

#### Scenario: All stages run in order on a green run

- **WHEN** a run succeeds end-to-end
- **THEN** the per-stage log files in `logs/` exist with timestamps in the order above

### Requirement: Each stage is a fresh Claude session

Each stage SHALL be invoked as `claude -p "$(cat /pipeline/prompts/<stage>.md)" ...` with no session-resume flag. No conversational state SHALL be carried between stages; the only communication channel between stages is the files in `artifacts/`.

#### Scenario: No session resumption flag is used

- **WHEN** any stage invokes `claude`
- **THEN** the command line does not include `--resume`, `--session-id`, or any equivalent flag

### Requirement: Single primary artifact per stage

Each stage SHALL produce exactly one primary output artifact in `artifacts/`. If a stage emits multiple files (e.g., a review document and a revised version), it SHALL designate one as the primary output and the pipeline SHALL only require the primary file to exist for the stage to be considered successful. Required primary artifacts per stage:

| Stage | Primary artifact |
|---|---|
| `01-parse` | `artifacts/context.json` |
| `02-spec` | `artifacts/spec.md` |
| `03-challenge-spec` | `artifacts/spec.md` (revised) + `artifacts/spec-review.md` (secondary) |
| `04-design` | `artifacts/design.md` |
| `05-challenge-design` | `artifacts/design.md` (revised) + `artifacts/design-review.md` (secondary) |
| `06-tasks` | `artifacts/tasks.md` |
| `07-implement` | git diff in `repo/` |
| `08-verify` | `artifacts/verdict.txt` containing `PASS` or `FAIL: <reasons>` |
| `09-pr` | PR URL (echoed to stdout, captured by the worker) |

#### Scenario: Stage success requires its primary artifact

- **WHEN** a stage exits 0 but its primary artifact does not exist
- **THEN** the pipeline treats the stage as failed and applies retry logic

### Requirement: Per-stage retry budget

The pipeline SHALL retry each failed stage up to `MAX_STAGE_RETRIES` times (default 3) before declaring the stage hard-failed and aborting the run. The retry count SHALL be recorded in `run.json.stages[i].attempts`.

#### Scenario: Stage succeeds after one retry

- **WHEN** `02-spec` exits non-zero on attempt 1 and exits 0 on attempt 2
- **THEN** `run.json.stages` records `attempts: 2` for `02-spec` and the pipeline continues

#### Scenario: Stage exhausts retries

- **WHEN** a stage exits non-zero on all `MAX_STAGE_RETRIES` attempts
- **THEN** the pipeline exits with that stage's exit code and does not run subsequent stages

### Requirement: Prompts are markdown data

Prompt content SHALL live in `pipeline/prompts/<stage>.md`. Prompts SHALL reference prior artifacts by relative path from `repo/` (e.g., `../artifacts/spec.md`). Prompts SHALL NOT be generated at runtime, templated from code, or fetched over the network.

#### Scenario: Prompts are static files on disk

- **WHEN** any stage runs
- **THEN** its prompt text comes from `cat /pipeline/prompts/<stage>.md` and from nowhere else

### Requirement: Working directory and environment per stage

The pipeline SHALL invoke each stage with `cwd = $RUN_DIR/repo` and SHALL export these environment variables to the stage process: `RUN_DIR`, `ARTIFACTS_DIR=$RUN_DIR/artifacts`, `LOGS_DIR=$RUN_DIR/logs`, `STAGE_NAME`, plus the flattened `TaskTrigger` fields (`TRIGGER_ID`, `ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_URL`, `ISSUE_AUTHOR`, `REPO_OWNER`, `REPO_NAME`, `TRIGGER_SOURCE`, `ACTOR`).

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

### Requirement: Adversarial challenge stages

Stages `03-challenge-spec` and `05-challenge-design` SHALL be adversarial: their prompts SHALL instruct Claude to find gaps, contradictions, and missing requirements in the prior stage's artifact, and SHALL produce both a review document (`spec-review.md` / `design-review.md`) and a revised version of the original artifact in place.

#### Scenario: Challenge-spec revises the spec

- **WHEN** `03-challenge-spec` runs
- **THEN** `artifacts/spec.md` has been rewritten (its content differs from the version produced by `02-spec`) and `artifacts/spec-review.md` exists describing the gaps that were addressed