## ADDED Requirements

### Requirement: run.json shape and lifecycle

Each run SHALL produce a `workspace/runs/<triggerId>/run.json` file conforming to the `RunMetadata` type in `spec.md §5.3`. The file SHALL be initialized at run start with `status: "running"` and `startedAt`, updated incrementally as stages complete, and finalized exactly once before the task file is moved out of `processing/`. The terminal `status` SHALL be one of `success`, `failed`, or `aborted-cost`.

#### Scenario: run.json is initialized at start

- **WHEN** the worker claims a task and creates the run directory
- **THEN** `run.json` exists with `status: "running"`, `startedAt` populated, and `stages: []`

#### Scenario: Each stage appends to run.json

- **WHEN** a stage exits (success or failure)
- **THEN** a new entry is appended to `run.json.stages` with `name`, `attempts`, `durationMs`, `inputTokens`, `outputTokens`, `costUsd`, and `exitCode`

#### Scenario: Terminal status is set exactly once

- **WHEN** the run reaches a terminal state
- **THEN** `run.json.endedAt` and `run.json.status` are set, and no further writes occur

### Requirement: Per-stage token and cost capture

For each stage, the pipeline SHALL record `inputTokens`, `outputTokens`, and `costUsd`. Cost SHALL be computed locally as `inputTokens * input_rate + outputTokens * output_rate` using a per-model pricing table maintained in the worker codebase. Token counts SHALL be parsed from `claude -p` output (stderr or a structured output mode), not estimated.

#### Scenario: Cost is computed from real token counts

- **WHEN** stage `task-planner` consumes 1000 input tokens and produces 500 output tokens on a model with rates $3/Mtok in and $15/Mtok out
- **THEN** `run.json.stages[i].costUsd ≈ 0.003 + 0.0075 = 0.0105`

### Requirement: Cost kill-switch between stages

After each stage, before invoking the next, the pipeline SHALL compute `totalCostUsd = sum(stages[*].costUsd)`. If `totalCostUsd >= MAX_COST_USD`, the pipeline SHALL exit with status 42 (cost-aborted) without running further stages. The worker SHALL then post a comment on the source issue summarizing the cost breakdown and SHALL move the task to `failed/`.

#### Scenario: Run within budget continues

- **WHEN** after a stage `totalCostUsd = 1.20` and `MAX_COST_USD = 5.00`
- **THEN** the next stage runs normally

#### Scenario: Run exceeding budget aborts

- **WHEN** after a stage `totalCostUsd = 5.10` and `MAX_COST_USD = 5.00`
- **THEN** the pipeline exits 42, `run.json.status` becomes `aborted-cost`, a cost-summary comment is posted on the issue, and the task moves to `failed/`

### Requirement: Total cost accumulation

`run.json.totalCostUsd` SHALL be updated after each stage to equal the sum of `stages[*].costUsd`. The field SHALL never decrease and SHALL be final once the run reaches a terminal status.

#### Scenario: Total cost equals stage sum

- **WHEN** stages have costs `[0.01, 0.04, 0.02]` recorded so far
- **THEN** `run.json.totalCostUsd === 0.07`

### Requirement: Per-stage duration capture

The pipeline SHALL record `durationMs` for each stage as the wall-clock time between stage start and stage end (across all retry attempts combined).

#### Scenario: Duration covers all retries

- **WHEN** a stage takes 30s on attempt 1 (fail) and 45s on attempt 2 (success)
- **THEN** `run.json.stages[i].durationMs ≈ 75000`

### Requirement: Failure reason capture

When a run terminates with `status: "failed"` or `status: "aborted-cost"`, `run.json.failureReason` SHALL be populated with a short human-readable string identifying the cause (e.g., `"stage task-executor exhausted 3 retries"`, `"cost ceiling exceeded: $5.10 > $5.00"`, `"empty diff"`).

#### Scenario: Hard failure records reason

- **WHEN** stage `task-executor` exhausts its retries
- **THEN** `run.json.failureReason` contains `"task-executor"` and `"retries"`

#### Scenario: Cost abort records reason

- **WHEN** the kill-switch fires
- **THEN** `run.json.failureReason` contains `"cost"` and the offending dollar amount