# Implementation Tasks — Remote SDD Agent

Tasks are grouped by the 8 phases from `spec.md §8` (M1–M8). Each phase ends with an explicit acceptance test (see `design.md §D9`). Do not start phase N+1 until phase N's acceptance test passes.

## 1. M1 — Skeleton

- [x] 1.1 Create top-level directory layout: `receiver/src`, `receiver/test`, `worker/src`, `worker/test`, `pipeline/prompts`, `shared/src`, `workspace/queue/{pending,processing,done,failed}`, `workspace/runs`, `workspace/state`
- [x] 1.2 Add `.gitkeep` files to keep empty `workspace/queue/*` directories tracked
- [x] 1.3 Write root `.env.example` listing every variable from `agent-configuration/spec.md` with inline purpose comments and defaults
- [x] 1.4 Update root `.gitignore` to exclude `.env`, `workspace/queue/*/*.json`, `workspace/runs/*`, `workspace/state/*.db*`, and `node_modules`
- [x] 1.5 Write `receiver/Dockerfile` based on `node:20-alpine`, copying `package.json` first for layer caching, exposing the HTTP port, running as a non-root user
- [x] 1.6 Write `worker/Dockerfile` based on `node:20-bullseye` (needs `git` + `gh` CLI), installing `git`, `gh`, and the `claude` CLI; pin versions
- [x] 1.7 Write `docker-compose.yml` with two services (`receiver`, `worker`), a shared named volume `workspace` mounted at `/workspace`, `env_file: .env`, `receiver` publishing port 3000:3000, worker `depends_on: receiver`
- [x] 1.8 Add `shared/` mini-package with TypeScript type definitions for `TaskTrigger`, `Context`, and `RunMetadata` from `spec.md §5`; consumed by both services via relative import or workspace
- [x] 1.9 Initialize root `package.json` as a workspaces root referencing `receiver`, `worker`, `shared`
- [x] 1.10 Expand `README.md` with the 5-step setup path required by `agent-configuration/spec.md`
- [x] 1.11 **Acceptance**: `docker compose up` brings both containers up; `curl localhost:3000/health` returns 200 with `{ "status": "ok" }` (health endpoint stubbed for now)

## 2. M2 — Receiver

- [x] 2.1 Initialize `receiver/package.json` with deps: `express`, `tsx`, `typescript`, `@types/express`, `@types/node`
- [x] 2.2 Set up `receiver/tsconfig.json` targeting Node 20, strict mode
- [x] 2.3 Implement `receiver/src/config.ts`: load and validate env vars per `agent-configuration/spec.md`; fail fast with a clear message on missing required vars
- [x] 2.4 Implement `receiver/src/server.ts` Express app: apply `express.json({ verify: (req,_res,buf) => req.rawBody = buf })` middleware
- [x] 2.5 Implement `GET /health` returning `200 { "status": "ok" }`
- [x] 2.6 Implement `receiver/src/verifySignature.ts`: compute `sha256=<hex>` HMAC over `req.rawBody`, compare with `crypto.timingSafeEqual` against equal-length buffers; reject 401 if absent or mismatched
- [x] 2.7 Implement `receiver/src/filters/botFilter.ts`: returns true if `payload.sender.login` ends with `[bot]`
- [x] 2.8 Implement `receiver/src/filters/repoFilter.ts`: parses `ALLOWED_REPOS` CSV once at boot, returns true if `payload.repository.full_name` is in the set
- [x] 2.9 Implement `receiver/src/triggerMap.ts`: pure functions `labelTrigger`, `statusTrigger`, `mentionTrigger`, each returning `TaskTrigger | null` from a payload + headers
- [x] 2.10 Implement `receiver/src/enqueue.ts`: write `.<triggerId>.json.tmp` to `pending/`, then atomic `rename()`; return triggerId
- [x] 2.11 Wire `/webhook` route: verify → bot filter → repo filter → map to trigger → enqueue → respond per the response-code matrix (202/204/401/500); ensure ack <100ms
- [x] 2.12 Add unit tests for `verifySignature` (good/bad/missing/timing-safe), `botFilter`, `repoFilter`, and each `triggerMap` function
- [x] 2.13 Add an integration test using `supertest` that posts a signed `issues.labeled` payload and asserts a file appears in `pending/`
- [x] 2.14 **Acceptance**: a signed `issues.labeled` payload for a whitelisted repo with `label.name = $TRIGGER_LABEL` produces `workspace/queue/pending/<triggerId>.json`; an unsigned payload returns 401; a `[bot]` sender returns 204; a non-whitelisted repo returns 204

## 3. M3 — Worker stub

- [x] 3.1 Initialize `worker/package.json` with deps: `typescript`, `tsx`, `@types/node`
- [x] 3.2 Set up `worker/tsconfig.json` matching the receiver
- [x] 3.3 Implement `worker/src/config.ts`: same env-var validation pattern as receiver
- [x] 3.4 Implement `worker/src/queue.ts`: `claimNext()` that scans `pending/` for non-hidden `*.json`, calls atomic `rename()` to `processing/`, returns `{ triggerId, payload }` or null on empty/ENOENT
- [x] 3.5 Implement `worker/src/queue.ts` helpers `moveToDone(triggerId)` and `moveToFailed(triggerId)` using `rename()`
- [x] 3.6 Implement `worker/src/main.ts` poll loop: claim → log → sleep 1s on empty → move to `done/` immediately (stub behavior)
- [x] 3.7 Add a graceful-shutdown handler on SIGTERM that finishes the current iteration before exiting
- [x] 3.8 Add unit tests for queue operations including ENOENT race scenario (two concurrent `claimNext()` calls)
- [x] 3.9 **Acceptance**: trigger a payload via M2's receiver; observe the file move `pending → processing → done` within 2 seconds in worker logs

## 4. M4 — Worker + naive Claude call

- [x] 4.1 Add to `worker/Dockerfile`: ensure `git`, `gh`, and the `claude` CLI are installed and on PATH; pin versions
- [x] 4.2 Implement `worker/src/runWorkspace.ts`: create `workspace/runs/<triggerId>/{repo,artifacts,logs}` and write initial `run.json` with `status: "running"`, `startedAt`, empty `stages`
- [x] 4.3 Implement `worker/src/gitOps.ts#cloneRepo(trigger, dest)`: build `https://x-access-token:${GITHUB_TOKEN}@github.com/<owner>/<name>` URL, run `git clone`, never log the token
- [x] 4.4 Implement `worker/src/gitOps.ts#createBranch(repoDir, trigger)`: branch name `agent/<issue-number>-<slug>-<shortTriggerId>`, slug = kebab(title) truncated to 40 chars
- [x] 4.5 Implement `worker/src/claudeCall.ts#naive(trigger, repoDir)`: invoke `claude -p "Fix issue #<N>: <title>\n\n<body>"` with `cwd = repoDir`, tee output to `$LOGS_DIR/naive.log`
- [x] 4.6 Implement `worker/src/prCreate.ts#createPr(repoDir, trigger, body)`: `git add -A && git commit -m "agent: <title> (closes #N)" && git push -u origin <branch> && gh pr create --title ... --body ... --label agent:created`; capture and return the PR URL
- [x] 4.7 Implement `worker/src/notify.ts#commentOnIssue(trigger, body)`: shell out to `gh issue comment <N> --repo <owner>/<name> --body "..."`
- [x] 4.8 Replace the M3 stub poll-loop body with: prepare workspace → clone → checkout branch → naive Claude call → if diff non-empty: create PR + comment back → move to `done/` or `failed/`
- [x] 4.9 Add an "empty diff" guard that fails the run with `failureReason: "empty-diff"` and skips PR creation
- [ ] 4.10 **Acceptance**: label a real issue on a test repo with `$TRIGGER_LABEL`; within ~5 minutes a PR is opened against that issue and the issue receives a comment with the PR URL

## 5. M5 — SDD pipeline: minimum viable stages

- [ ] 5.1 Create `pipeline/pipeline.sh` skeleton: `set -euo pipefail`, read `RUN_DIR` from env, define a `run_stage <stage-name> <primary-artifact>` bash function
- [ ] 5.2 Implement retry logic in `run_stage`: loop up to `MAX_STAGE_RETRIES`, append stdout+stderr to `$LOGS_DIR/<stage>.log`, on each attempt verify the primary artifact exists, break on success
- [ ] 5.3 Implement env-var setup in `pipeline.sh`: export `ARTIFACTS_DIR`, `LOGS_DIR`, `STAGE_NAME`; assume `TRIGGER_ID`, `ISSUE_*`, `REPO_*`, `TRIGGER_SOURCE`, `ACTOR` are inherited from the worker
- [ ] 5.4 Implement stage invocation: `cd $RUN_DIR/repo && claude -p "$(cat /pipeline/prompts/<stage>.md)" --output-file "$ARTIFACTS_DIR/<artifact>"` (verify the exact `claude -p` output-file flag against the installed CLI; adjust per its actual contract)
- [ ] 5.5 Write `pipeline/prompts/01-parse.md`: instructs Claude to consume `$ISSUE_TITLE`/`$ISSUE_BODY` and emit `context.json` matching the `Context` interface in `spec.md §5.2`
- [ ] 5.6 Write `pipeline/prompts/02-spec.md`: consumes `../artifacts/context.json` (relative to `repo/`), emits `spec.md` — precise, testable specification
- [ ] 5.7 Write `pipeline/prompts/07-implement.md`: consumes `../artifacts/spec.md` and the repo tree, edits files in place to implement the spec
- [ ] 5.8 Write `pipeline/prompts/08-verify.md`: consumes the current git diff and `../artifacts/spec.md`, emits `verdict.txt` with `PASS` or `FAIL: <reasons>` on the first line
- [ ] 5.9 Wire the four stages in `pipeline.sh`: parse → spec → implement → verify, in order, aborting if any stage hard-fails
- [ ] 5.10 In `worker/src/main.ts`, replace the M4 naive Claude call with `bash /pipeline/pipeline.sh` invocation; capture exit code; build PR body from `spec.md` + `verdict.txt`
- [ ] 5.11 If `verdict.txt` starts with `FAIL:`, still open the PR but as draft and include the failure reasons in the PR body
- [ ] 5.12 **Acceptance**: same trigger as M4; `workspace/runs/<id>/artifacts/` contains `context.json`, `spec.md`, `verdict.txt`; the PR body embeds the contents of `spec.md`

## 6. M6 — SDD pipeline: challenge stages

- [ ] 6.1 Write `pipeline/prompts/03-challenge-spec.md`: adversarial prompt — find gaps in `spec.md`, write `spec-review.md`, then rewrite `spec.md` in place addressing them
- [ ] 6.2 Write `pipeline/prompts/04-design.md`: consumes `spec.md` and the repo tree, emits `design.md` identifying files to touch and proposed interfaces
- [ ] 6.3 Write `pipeline/prompts/05-challenge-design.md`: adversarial prompt — find risks/alternatives in `design.md`, write `design-review.md`, then rewrite `design.md` in place
- [ ] 6.4 Write `pipeline/prompts/06-tasks.md`: consumes `design.md`, emits `tasks.md` with atomic, ordered work items
- [ ] 6.5 Update `pipeline.sh` to run the full 8-stage sequence (parse → spec → challenge-spec → design → challenge-design → tasks → implement → verify), in order
- [ ] 6.6 For stages 03 and 05, modify `run_stage` (or invoke a special variant) so it accepts the in-place rewrite of an existing artifact as success (primary artifact must exist; consider also requiring the secondary review file)
- [ ] 6.7 Update worker PR-body composition to embed `spec.md`, `design.md`, and `tasks.md` as labeled sections, with `spec-review.md` and `design-review.md` included in a collapsed `<details>` block
- [ ] 6.8 **Acceptance**: trigger a run; all six pre-implement artifacts exist; PR description contains every artifact under a labeled section

## 7. M7 — Observability & safety

- [ ] 7.1 Implement `worker/src/runJson.ts`: helpers `init(runDir, trigger)`, `appendStage(runDir, stageRecord)`, `finalize(runDir, status, failureReason?)`, all using atomic write-then-rename to avoid partial reads
- [ ] 7.2 Maintain a `MODEL_PRICING` table in `worker/src/pricing.ts` keyed by model id with `inputUsdPerMtok` and `outputUsdPerMtok`; add Sonnet 4.6 / Opus 4.7 / Haiku 4.5 rates
- [ ] 7.3 Parse token usage from `claude -p` output (confirm structured output mode or stderr format against the installed CLI); compute `costUsd` per stage; append a stage record to `run.json` after each stage
- [ ] 7.4 In `pipeline.sh`, between stages, read `run.json.totalCostUsd`, compare to `MAX_COST_USD`; if exceeded, exit 42
- [ ] 7.5 In the worker, treat pipeline exit code 42 specially: set `run.json.status = "aborted-cost"`, populate `failureReason` with the breakdown, post a cost-summary comment on the source issue, move the task to `failed/`
- [ ] 7.6 Add `receiver/src/dedupe.ts` backed by `better-sqlite3` at `workspace/state/deliveries.db` (schema: `deliveries(delivery_id TEXT PRIMARY KEY, seen_at INTEGER)`); on each authenticated request: `INSERT OR IGNORE`; if it was a duplicate, respond `200 { "status": "duplicate" }`
- [ ] 7.7 On each insert, opportunistically `DELETE FROM deliveries WHERE seen_at < strftime('%s','now') - 86400`
- [ ] 7.8 Add tests: cost ceiling abort, replay dedupe (first call enqueues, second returns duplicate, third after 24h fake-clock advance enqueues again)
- [ ] 7.9 **Acceptance**: setting `MAX_COST_USD=0.01` aborts a real run mid-pipeline with an issue comment; replaying a captured delivery returns the duplicate response; `run.json` for a green run contains per-stage `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `exitCode`

## 8. M8 — Polish

- [ ] 8.1 Implement `worker/src/recovery.ts#sweepStaleProcessing()`: scan `processing/` at worker startup, find files with mtime older than 1 hour, atomically rename back to `pending/`; run before entering the main loop
- [ ] 8.2 Add a test that creates a stale `processing/X.json` and asserts startup recovery moves it back to `pending/`, while a fresh one is left alone
- [ ] 8.3 Optionally close the previous PR when re-triggering the same issue (deferred decision from `spec.md §9` — v1 just opens a second PR; do nothing extra unless time permits)
- [ ] 8.4 Add a `docs/prompt-tuning.md` (or expand README) covering: how to edit a prompt, how to test a single stage in isolation (`RUN_DIR=... STAGE_NAME=02-spec bash -c '...'`), and how to inspect `run.json` for cost/token regressions
- [ ] 8.5 Final pass on README: copy-edit setup, link to spec.md, link to OpenSpec change directory, document the kill-switch and how to recover a failed run
- [ ] 8.6 **Acceptance**: a `processing/X.json` aged >1h is recovered on next worker start; `docs/prompt-tuning.md` exists and covers the three workflows above
