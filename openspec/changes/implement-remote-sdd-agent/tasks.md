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
- [x] 4.10 **Acceptance**: label a real issue on a test repo with `$TRIGGER_LABEL`; within ~5 minutes a PR is opened against that issue and the issue receives a comment with the PR URL — verified on `alex-popkov/third-gate-rn` issue #9 → PR #10 (base `develop`) + issue comment

## 5. M5 — SDD pipeline: minimum viable agent stages

The pipeline is **agent-based**, not prompt-based. Each stage runs a fresh `claude -p` session driving one of the stack-agnostic subagents in `pipeline/agents/` (`task-researcher`, `task-planner`, `task-executor`, `task-verifier`; `specification-from-artifacts` lands in M6). Agents read and write their own artifacts under the repo's `.claude/sdd-tracking/` tree (`research/`, `plans/`, `details/`, `prompts/`, `changes/`, `verification/`); the rule "each stage = a fresh session, state passes only via files" still holds. See `pipeline/agents/readme.md` for the pipeline contract.

- [x] 5.1 Create `pipeline/pipeline.sh` skeleton: `set -euo pipefail`, read `RUN_DIR` from env, define a `run_stage <agent-name> <expected-artifact-glob>` bash function
- [x] 5.2 Implement retry logic in `run_stage`: loop up to `MAX_STAGE_RETRIES`, append stdout+stderr to `$LOGS_DIR/<agent-name>.log`, on each attempt verify at least one file matching the expected-artifact glob exists (and is newer than the stage start), break on success
- [x] 5.3 Implement env-var setup in `pipeline.sh`: export `ARTIFACTS_DIR`, `LOGS_DIR`, `STAGE_NAME`; assume `TRIGGER_ID`, `ISSUE_*`, `REPO_*`, `TRIGGER_SOURCE`, `ACTOR` are inherited from the worker
- [x] 5.4 Make the agents discoverable to the CLI and prepare the artifact tree: copy `pipeline/agents/*.md` into `$RUN_DIR/repo/.claude/agents/` (or invoke the CLI with an explicit agents directory); create `$RUN_DIR/repo/.claude/sdd-tracking/{research,plans,details,prompts,changes,verification}`; symlink it to `$ARTIFACTS_DIR` so artifacts persist in the run dir for the worker and observability (verify the exact subagent-selection mechanism against the installed CLI and adjust)
- [x] 5.5 Implement stage invocation: `cd $RUN_DIR/repo && claude -p "<task instruction>" --agent <agent-name>` passing the issue context (`$ISSUE_TITLE`/`$ISSUE_BODY`/issue number) in the instruction (confirm the actual flag for selecting a subagent non-interactively against the installed CLI; adjust per its real contract)
- [x] 5.6 **Research stage** — run `task-researcher` with the issue title/body as the task; expect a `*-research.md` file in `.claude/sdd-tracking/research/`
- [x] 5.7 **Plan stage** — run `task-planner`; expect `*-plan.instructions.md` (plans/), `*-details.md` (details/), and `implement-*.prompt.md` (prompts/)
- [x] 5.8 **Execute stage** — run `task-executor` pointed at the generated `implement-*.prompt.md` in continuous mode; it edits repo files in place and writes a `*-changes.md` in `.claude/sdd-tracking/changes/`
- [x] 5.9 **Verify stage** — run `task-verifier`; expect a `*-verification.md` in `.claude/sdd-tracking/verification/` whose first line is `VERDICT: PASS` or `VERDICT: FAIL`
- [x] 5.10 Wire the four stages in `pipeline.sh`: researcher → planner → executor → verifier, in order, aborting if any stage hard-fails (no expected artifact after retries)
- [x] 5.11 Implement the verify→execute feedback loop: if the verdict is `FAIL`, re-run `task-executor` (feeding it the verification report) up to a bounded number of attempts (e.g. `MAX_VERIFY_RETRIES`, default 1), re-running `task-verifier` after each; carry the final verdict forward
- [x] 5.12 In `worker/src/main.ts`, replace the M4 naive Claude call with a `bash /pipeline/pipeline.sh` invocation; capture the exit code; build the PR body from the plan (`*-plan.instructions.md`), the changes summary (`*-changes.md`), and the verification report (`*-verification.md`)
- [x] 5.13 If the final verdict is `FAIL`, still open the PR but as **draft** and include the verifier's blocking findings in the PR body
- [x] 5.14 **Acceptance**: same trigger as M4; `workspace/runs/<id>/artifacts/` (via the `.claude/sdd-tracking` symlink) contains research, plan, changes, and verification artifacts; the verification artifact carries a `VERDICT:` line; the PR body embeds the plan and the verdict, and the PR is a draft when the verdict is `FAIL` — verified on issue #9 (`VERDICT: PASS` → normal PR #10)
- [ ] 5.15 **Follow-up (verify-loop robustness)**: on a real run, `task-verifier` prepended a `<!-- markdownlint-disable-file -->` line, pushing `VERDICT: PASS` off line 1; `read_verdict` only checked `head -1` and misread it as `FAIL`, triggering a needless re-execute. `read_verdict` now scans for the first `VERDICT:` line (fixed). Remaining gap: the re-execute loop (5.11) re-runs `task-executor` requiring a **fresh** `*-changes.md`, but when the executor addresses findings without rewriting that file (or has nothing new to do) the stage fails after `MAX_STAGE_RETRIES` ("no `*-changes.md` after 3 attempts"). Allow an in-place mtime bump / no-op as success for the executor on retry, mirroring the rule M6 task 6.2 adds for plan-challenge.

## 6. M6 — SDD pipeline: full agent pipeline (challenge + specification)

The old prompt-based challenge stages (`challenge-spec`, `challenge-design`) and the separate `design`/`tasks` prompts are gone. In the agent pipeline, design and task breakdown are already produced by `task-planner` (M5), and the adversarial "challenge" role is realized by **agents in fresh sessions**, not standalone prompts: a pre-implementation **plan-challenge** pass (a fresh `task-planner` session run in critique mode) and the post-implementation **verify loop** (`task-verifier`, M5). M6 adds the plan-challenge pass and completes the pipeline with the final `specification-from-artifacts` stage. The rule "each stage = a fresh `claude -p` session, state passes only via files" still holds.

- [x] 6.1 Add an adversarial **plan-challenge** stage to `pipeline.sh` between plan and execute, gated behind `ENABLE_PLAN_CHALLENGE` (default on). Run a **fresh `task-planner` session in critique mode** (same agent, different instruction) that reads the existing `*-plan.instructions.md` / `*-details.md`, finds gaps, risks, ambiguities, and missing edge cases, and **revises those files in place**. No new artifact and no `challenge/` dir — the revised plan/details *are* the output, and the executor consumes them directly. Successor to the old `03-challenge-spec` / `05-challenge-design` prompts. Requires decoupling the stage label from the agent name in `invoke_agent` (so the stage logs to `plan-challenge.log` while invoking `--agent task-planner`)
- [x] 6.2 Run plan-challenge as a **best-effort, single-attempt** stage, NOT via the strict `run_stage` (whose retry-until-artifact + hard-fail would wrongly sink the run when the challenge judges the plan already sound and edits nothing). Invoke the agent once; compare `*-plan.instructions.md` / `*-details.md` mtime against the stage-start marker and `log` "plan revised" vs "no changes — proceeding"; always return success so the pipeline continues regardless
- [x] 6.3 Add the **specification** stage to `pipeline.sh`, run only when the final verdict is `PASS`: invoke `specification-from-artifacts` to distill a permanent spec under `.claude/specs/<module>/` plus an updated `.claude/specs/INDEX.md`. Unlike `.claude/sdd-tracking/` (gitignored working artifacts), `.claude/specs/` is committed and becomes part of the PR diff — `setup_workspace` must `mkdir -p .claude/specs` and must NOT add it to `.git/info/exclude`. Three specifics: (a) the stage instruction must tell the agent to act **autonomously** — create-or-update without asking (the agent's own definition says "if unsure, ask the user", which deadlocks a non-interactive `claude -p` session); (b) key stage success on **`.claude/specs/INDEX.md` updated** (mtime newer than stage start), since the agent always maintains INDEX but spec filenames vary (`spec-*.md` is not guaranteed) — do not rely on a `spec-*.md` glob; (c) run it **best-effort** (see 6.4)
- [x] 6.4 Update `pipeline.sh` to run the full agent sequence in order: researcher → planner → plan-challenge (best-effort, 6.1/6.2) → executor → verifier (+ verify loop) → specification (on `PASS`). Hard-fail the run only for the core stages (researcher, planner, executor, verifier). The specification stage is **best-effort**: it runs after a `PASS` verdict, so a spec hiccup must NOT discard a verified implementation — on spec-stage failure, `log` a warning and continue so the worker still opens the (passing) PR. The final exit code reflects the core pipeline, not plan-challenge or specification
- [x] 6.5 Update the worker PR-body composition to embed the agent artifacts as labeled sections: research summary, plan + details (already reflecting the plan-challenge revisions), changes summary, and the permanent spec; put the verification report in a collapsed `<details>` block. Plan-challenge has no artifact of its own — its effect shows up in the embedded plan/details; the raw critique session stays in `logs/plan-challenge.log` for debugging only
- [x] 6.6 **Acceptance**: trigger a run; `.claude/sdd-tracking/` contains research, plan/details, changes, and verification artifacts, and (on `PASS`) `.claude/specs/` contains the committed permanent spec; the PR description contains every artifact under a labeled section and the committed spec file appears in the PR diff — verified on issue #11 → PR #12 (plan-challenge revised the plan; spec `dreams/spec-design-remove-dreams-filter.md` + `INDEX.md` committed in the diff; PR body has Plan/Plan details/Changes/Specification/Verification sections)

## 7. M7 — Observability & safety

- [x] 7.1 Implement `worker/src/runJson.ts`: helpers `init(runDir, trigger)`, `appendStage(runDir, stageRecord)`, `finalize(runDir, status, failureReason?)`, all using atomic write-then-rename to avoid partial reads
- [x] 7.2 Maintain a `MODEL_PRICING` table in `worker/src/pricing.ts` keyed by model id with `inputUsdPerMtok` and `outputUsdPerMtok`; add Sonnet 4.6 / Opus 4.7 / Haiku 4.5 rates — done, plus the current Claude 5 family (the agents' `opus`/`sonnet` aliases resolve there), a `cacheReadUsdPerMtok` column, cache writes at the 1h rate (2x input), longest-prefix id matching, and unknown ids priced at the highest rate
- [x] 7.3 Parse token usage from `claude -p` output (confirm structured output mode or stderr format against the installed CLI); compute `costUsd` per stage; append a stage record to `run.json` after each stage — confirmed: `claude -p --output-format json` prints a result object whose `modelUsage` gives per-model input/output/cache-read/cache-write tokens; `pipeline.sh` saves one per attempt to `logs/usage/` and calls the compiled `worker/src/recordStage.ts` (`RECORD_STAGE_JS`). Local pricing matches the CLI's own `total_cost_usd` on a real call
- [x] 7.4 In `pipeline.sh`, between stages, read `run.json.totalCostUsd`, compare to `MAX_COST_USD`; if exceeded, exit 42
- [x] 7.5 In the worker, treat pipeline exit code 42 specially: set `run.json.status = "aborted-cost"`, populate `failureReason` with the breakdown, post a cost-summary comment on the source issue, move the task to `failed/`
- [x] 7.6 Add `receiver/src/dedupe.ts` backed by `better-sqlite3` at `workspace/state/deliveries.db` (schema: `deliveries(delivery_id TEXT PRIMARY KEY, seen_at INTEGER)`); on each authenticated request: `INSERT OR IGNORE`; if it was a duplicate, respond `200 { "status": "duplicate" }`
- [x] 7.7 On each insert, opportunistically `DELETE FROM deliveries WHERE seen_at < strftime('%s','now') - 86400` — implemented with an injected clock (`seen_at < ?`) so tests can advance time; a delivery whose enqueue fails is forgotten so GitHub's redelivery (same id) still goes through
- [x] 7.8 Add tests: cost ceiling abort, replay dedupe (first call enqueues, second returns duplicate, third after 24h fake-clock advance enqueues again)
- [ ] 7.9 **Acceptance**: setting `MAX_COST_USD=0.01` aborts a real run mid-pipeline with an issue comment; replaying a captured delivery returns the duplicate response; `run.json` for a green run contains per-stage `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `exitCode`

## 8. M8 — Polish

- [ ] 8.1 Implement `worker/src/recovery.ts#sweepStaleProcessing()`: scan `processing/` at worker startup, find files with mtime older than 1 hour, atomically rename back to `pending/`; run before entering the main loop
- [ ] 8.2 Add a test that creates a stale `processing/X.json` and asserts startup recovery moves it back to `pending/`, while a fresh one is left alone
- [ ] 8.3 Optionally close the previous PR when re-triggering the same issue (deferred decision from `spec.md §9` — v1 just opens a second PR; do nothing extra unless time permits)
- [ ] 8.4 Add a `docs/agent-tuning.md` (or expand README) covering: how to edit an agent in `pipeline/agents/`, how to run a single stage in isolation (`RUN_DIR=... STAGE_NAME=task-planner bash -c '...'`), and how to inspect `run.json` for cost/token regressions
- [ ] 8.5 Final pass on README: copy-edit setup, link to spec.md, link to OpenSpec change directory, document the kill-switch and how to recover a failed run
- [ ] 8.6 **Acceptance**: a `processing/X.json` aged >1h is recovered on next worker start; `docs/prompt-tuning.md` exists and covers the three workflows above
