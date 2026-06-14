## ADDED Requirements

### Requirement: Poll loop with backoff

The worker SHALL run a poll loop that scans `workspace/queue/pending/` for non-hidden `*.json` files. When the directory is empty, it SHALL sleep for 1 second before re-scanning. When a task is found, it SHALL attempt to claim it via atomic `rename()`.

#### Scenario: Empty queue sleeps and retries

- **WHEN** `pending/` contains no non-hidden `*.json` files
- **THEN** the worker sleeps 1 second and scans again

#### Scenario: Task present triggers a claim attempt

- **WHEN** `pending/` contains at least one `*.json` file
- **THEN** the worker calls `rename(pending/X.json, processing/X.json)` to attempt a claim

### Requirement: Per-run workspace preparation

After claiming task `<triggerId>`, the worker SHALL create the directory tree `workspace/runs/<triggerId>/` containing subdirectories `repo/`, `artifacts/`, and `logs/`, and an initial `run.json` with `status: "running"` and `startedAt` set to the current ISO-8601 timestamp.

#### Scenario: Run directory tree is created

- **WHEN** a task is claimed
- **THEN** `workspace/runs/<triggerId>/repo/`, `workspace/runs/<triggerId>/artifacts/`, and `workspace/runs/<triggerId>/logs/` all exist, and `workspace/runs/<triggerId>/run.json` exists with `status: "running"`

### Requirement: Clone target repository on a fresh branch

The worker SHALL clone the target repository into `workspace/runs/<triggerId>/repo` using a token-authenticated HTTPS URL `https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${name}`, and SHALL check out a new branch named `agent/<issue-number>-<slug>-<shortTriggerId>` where `slug` is the kebab-cased issue title truncated to 40 characters and `shortTriggerId` is the trailing 8 characters of the trigger's unix-ms timestamp.

#### Scenario: Clone uses scoped token

- **WHEN** the worker clones a whitelisted repo
- **THEN** the remote URL embeds `GITHUB_TOKEN` as `x-access-token:<token>` and is never echoed to logs

#### Scenario: Branch name is collision-resistant

- **WHEN** the same issue is re-triggered later
- **THEN** the second run produces a different branch name because `shortTriggerId` differs

### Requirement: Invoke the SDD pipeline

The worker SHALL invoke `bash /pipeline/pipeline.sh` with `RUN_DIR` pointing at `workspace/runs/<triggerId>/` and with `TaskTrigger` fields exported as environment variables (`ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_URL`, `ISSUE_AUTHOR`, `REPO_OWNER`, `REPO_NAME`, `TRIGGER_SOURCE`, `ACTOR`, `TRIGGER_ID`). The worker SHALL capture the pipeline's exit code and treat 0 as success, 42 as cost-aborted, and any other non-zero as failure.

#### Scenario: Successful pipeline run

- **WHEN** `pipeline.sh` exits with code 0
- **THEN** the worker proceeds to PR creation

#### Scenario: Cost-aborted pipeline run

- **WHEN** `pipeline.sh` exits with code 42
- **THEN** the worker skips PR creation, sets `run.json.status = "aborted-cost"`, posts an abort comment on the source issue, and moves the task to `failed/`

#### Scenario: Hard-failed pipeline run

- **WHEN** `pipeline.sh` exits with any other non-zero code
- **THEN** the worker sets `run.json.status = "failed"` with `failureReason` populated, optionally posts a failure comment, and moves the task to `failed/`

### Requirement: Open a Pull Request on success

On pipeline completion, the worker SHALL push the agent branch to the remote and run `gh pr create` with:

- title: derived from the issue title (e.g., `"<issue title> (closes #<N>)"`)
- body: composed from the agent artifacts under `.claude/sdd-tracking/` (via `$ARTIFACTS_DIR`) — the plan (`plans/*-plan.instructions.md`), the changes summary (`changes/*-changes.md`), and the verification report (`verification/*-verification.md`) — plus the committed permanent spec under `.claude/specs/` when present, each under a clearly-labeled section; the verification report and any plan-challenge review notes MAY be placed in a collapsed `<details>` block
- labels: `agent:created`
- base: the repo's default branch
- draft: the PR SHALL be opened as a **draft** when the final verdict is `FAIL`, with the verifier's blocking findings included in the body

The resulting PR URL SHALL be written into `run.json.prUrl`.

#### Scenario: PR is opened and recorded

- **WHEN** the pipeline completes and the branch contains a non-empty diff
- **THEN** a PR is opened, its URL is captured, and `run.json.prUrl` is populated

#### Scenario: Failing verdict opens a draft PR

- **WHEN** the final verdict from `task-verifier` is `FAIL`
- **THEN** the PR is opened as a draft and its body includes the verifier's blocking findings

#### Scenario: Empty diff aborts PR creation

- **WHEN** the pipeline finishes but no files were changed in `repo/`
- **THEN** the worker treats the run as failed with `failureReason: "empty-diff"` and does not invoke `gh pr create`

### Requirement: Notify the source issue

After a successful PR creation, the worker SHALL post a comment on the source issue using `gh issue comment <N> --body "PR opened: <url>"`. The comment SHALL include the PR URL and a brief summary line.

#### Scenario: Issue receives PR-link comment

- **WHEN** the PR has been created
- **THEN** the source issue receives a new comment containing the PR URL

### Requirement: Task lifecycle bookkeeping

The worker SHALL update `run.json.endedAt` and `run.json.status` exactly once before moving the task file out of `processing/`. The terminal status SHALL be one of `success`, `failed`, or `aborted-cost`.

#### Scenario: Terminal state is recorded before move

- **WHEN** the worker is about to call `rename(processing/X.json, done/X.json)` or `rename(processing/X.json, failed/X.json)`
- **THEN** `run.json.endedAt` is set and `run.json.status` is one of the terminal values