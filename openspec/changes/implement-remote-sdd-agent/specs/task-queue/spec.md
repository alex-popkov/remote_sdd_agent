## ADDED Requirements

### Requirement: Queue directory layout

The system SHALL maintain a filesystem queue under `workspace/queue/` with exactly four subdirectories: `pending/`, `processing/`, `done/`, and `failed/`. All four SHALL exist on startup; producers and consumers SHALL NOT assume they will create them.

#### Scenario: Required directories exist after bootstrap

- **WHEN** either the receiver or worker container starts
- **THEN** `workspace/queue/pending`, `workspace/queue/processing`, `workspace/queue/done`, and `workspace/queue/failed` exist and are writable

### Requirement: Task file naming

Each queued task SHALL be a single JSON file whose basename is `<triggerId>.json`. The `triggerId` is `"<owner>__<repo>__<issue>__<unixMs>"`. The same `triggerId` SHALL be reused as the run-directory name under `workspace/runs/`.

#### Scenario: Filename matches triggerId

- **WHEN** a trigger with id `acme__widgets__42__1717000000000` is enqueued
- **THEN** the file is named `acme__widgets__42__1717000000000.json` (no other naming scheme is permitted)

### Requirement: Atomic enqueue contract

A producer SHALL enqueue by writing to a hidden temp file (`.<triggerId>.json.tmp`) under the destination directory and `rename()`ing it to the final name. Consumers scanning a directory SHALL ignore dotfiles.

#### Scenario: Partial writes are invisible to consumers

- **WHEN** a producer is interrupted mid-write
- **THEN** no consumer observes the partially-written file as a valid task

### Requirement: Atomic claim via rename

A worker SHALL claim a task by calling `rename('workspace/queue/pending/<id>.json', 'workspace/queue/processing/<id>.json')`. If the rename fails with `ENOENT`, the worker SHALL treat the task as taken by another worker and continue polling without raising an error.

#### Scenario: Successful claim moves the file

- **WHEN** a worker calls `rename(pending/X.json, processing/X.json)` and it succeeds
- **THEN** the file no longer exists in `pending/` and exists in `processing/`

#### Scenario: Concurrent claim loser sees ENOENT

- **WHEN** two workers race to claim the same task and one wins
- **THEN** the losing worker observes `ENOENT` from `rename()` and proceeds to the next task without aborting

### Requirement: Terminal state transitions

On completion, a worker SHALL move the file from `processing/` to either `done/` (success) or `failed/` (exceeded retries, hard error, or cost-aborted). The corresponding run directory under `workspace/runs/<triggerId>/` SHALL be preserved for postmortem.

#### Scenario: Successful run lands in done

- **WHEN** the pipeline completes successfully and a PR is opened
- **THEN** the task file is moved from `processing/` to `done/` and the run directory is left intact

#### Scenario: Failed run lands in failed

- **WHEN** the pipeline exhausts retries or a stage hard-fails
- **THEN** the task file is moved from `processing/` to `failed/` and the run directory is left intact

#### Scenario: Cost-aborted run lands in failed

- **WHEN** the pipeline aborts because `totalCostUsd >= MAX_COST_USD`
- **THEN** the task file is moved from `processing/` to `failed/` with `run.json.status = "aborted-cost"`

### Requirement: Idle-task recovery on worker startup

On startup, a worker SHALL scan `workspace/queue/processing/` and move any task file whose `mtime` is older than 1 hour back to `workspace/queue/pending/` so a fresh attempt can claim it. The recovery sweep SHALL run before the worker accepts new claims.

#### Scenario: Stale processing files are requeued

- **WHEN** the worker starts and finds `processing/X.json` with mtime older than 1 hour
- **THEN** the worker renames it to `pending/X.json` before entering its main loop

#### Scenario: Fresh processing files are left alone

- **WHEN** the worker starts and finds `processing/Y.json` with mtime less than 1 hour old
- **THEN** the worker leaves it in `processing/` (it may belong to another live worker)