## Context

`spec.md` is the source of truth and already pre-decides the major architectural shape: two containers (`receiver`, `worker`) wired by a shared volume holding a filesystem queue and per-run workspaces; a bash-driven SDD pipeline of 9 stages; HMAC-verified GitHub webhooks; and a cost ceiling enforced between stages. The current repo has empty directories for those components.

This change does *not* re-litigate those decisions. It records the implementation-level choices that follow from them: language/runtime, queue file format, signature implementation, branch naming, how stages discover their inputs, how cost is estimated, and how we order milestones so each one is independently demoable.

Constraints we inherit:
- Receiver must ack GitHub webhooks in <10s (we target <100ms).
- Single developer, single host, single worker — but the design must not foreclose multi-worker scale-out via atomic `rename()`.
- Code never leaves the user's infra → no third-party orchestration services (Temporal, GitHub Actions runners, etc.).
- Prompts are data; orchestration is bash — keep the moving parts visible.

## Goals / Non-Goals

**Goals:**

- Decompose the full spec into 8 phases (M1–M8) that map 1:1 to `spec.md §8`. Each phase ends with a concrete, demonstrable behavior.
- Lock in the receiver's HMAC + filter pipeline so security can't regress as features land later.
- Define the file-queue contract precisely enough that the receiver and worker can be built in parallel.
- Define the pipeline-stage contract (inputs, outputs, env vars, retry semantics) so prompts can iterate without touching `pipeline.sh`.
- Make cost and stage attempts observable from day one (M5 writes `run.json` even if M7 hardens the kill-switch).

**Non-Goals:**

- Designing the *content* of the stage prompts. That's an editorial activity owned by the implementer at M5+. We only design the *contract* the prompts plug into.
- A production-grade observability stack. v1 is "JSON files on disk + stdout"; Prometheus/OpenTelemetry are deferred.
- High-availability or zero-downtime deploy. Restarts are allowed to drop in-flight HTTP requests (GitHub retries), and crashed workers recover via the 1h idle-task sweep.
- Anything in `spec.md §2 Non-Goals` (Slack, Jira, Projects v2 webhooks, multi-tenancy, UI, distributed workers).

## Decisions

### D1. Runtime: Node 20 + TypeScript for both services

Both `receiver/` and `worker/` are Node + TS. Rationale: the worker shells out to `git`, `gh`, and `claude` constantly — Node's `child_process` is ergonomic — and the receiver needs Express + correct raw-body capture, which is a well-trodden Node path. Sharing a language means shared `TaskTrigger`/`RunMetadata` type definitions in a tiny `shared/` package.

Alternatives considered: Go for the receiver (smaller image, faster ack) — rejected because the speed gain is irrelevant at our scale and dual-language increases setup friction for a single-developer project. Pure bash for the worker — rejected because the queue claim, run-metadata bookkeeping, and PR-body templating get ugly fast.

### D2. Express for the receiver, with raw-body capture before JSON parsing

```ts
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
```

HMAC is then computed over `req.rawBody`, not `JSON.stringify(req.body)`. This is the rule from `spec.md §4.1` — re-stringified JSON has different bytes (whitespace, key order) and will not match GitHub's signature. Comparison uses `crypto.timingSafeEqual` against equal-length buffers.

The signature check runs as the **first** middleware after raw-body capture, before any business logic. Invalid → 401 in <1ms.

### D3. File queue format: `<triggerId>.json` with atomic temp-file enqueue

Enqueue is two steps:
1. Write `workspace/queue/pending/.<triggerId>.json.tmp` (leading dot = hidden, ignored by scans).
2. `rename()` it to `workspace/queue/pending/<triggerId>.json`.

Worker claim is `rename('pending/X.json', 'processing/X.json')` — `rename()` is atomic on the same filesystem (POSIX), so two workers can race safely; the loser sees `ENOENT` and moves on. This is the property `spec.md §4.2` calls out.

`triggerId = "<owner>__<repo>__<issue>__<unixMs>"` — `__` separator avoids confusion with `/` in `owner/name`. The same string is the run-directory name under `workspace/runs/`.

Alternatives considered: SQLite-backed queue — rejected for v1 (the file-queue rationale in `spec.md §3` already covers it); Redis — same. Both are easy to swap in later if `MAX ~100 tasks/min` becomes real.

### D4. Trigger normalization happens in the receiver, not the worker

The receiver maps GitHub's three event shapes into the single `TaskTrigger` type from `spec.md §5.1`. The worker only ever consumes `TaskTrigger` — it never inspects raw GitHub payloads. This means:
- Future trigger sources (Jira, Linear) only need a new receiver branch; the worker is vendor-agnostic.
- Replay/dedupe and `[bot]` filtering are centralized in one place.

The three v1 mappings (label / status-label / mention) are implemented as small pure functions returning `TaskTrigger | null`; `null` → respond 204.

### D5. Pipeline-stage contract

Every stage is invoked by `pipeline.sh` with this contract:

- **CWD**: `workspace/runs/<triggerId>/repo` (the cloned target repo).
- **Env vars**: `RUN_DIR` (absolute path to the run dir), `ARTIFACTS_DIR=$RUN_DIR/artifacts`, `LOGS_DIR=$RUN_DIR/logs`, `STAGE_NAME` (e.g. `02-spec`), plus all of the trigger fields (`ISSUE_NUMBER`, `ISSUE_TITLE`, etc.) flattened from `TaskTrigger`.
- **Command**: `claude -p "$(cat /pipeline/prompts/<stage>.md)" --output-file "$ARTIFACTS_DIR/<stage>.out"` (or stage-specific output filename per `spec.md §4.3`).
- **Exit code**: 0 = success, non-zero = retryable failure. Retries bounded by `MAX_STAGE_RETRIES`.
- **Logging**: stage stdout+stderr tee'd to `$LOGS_DIR/<stage>.log`.

Prompts reference prior artifacts by *relative path from CWD* (e.g. `../artifacts/spec.md`). This is a deliberate constraint: prompts must not assume absolute paths, so the same prompt file works regardless of where `RUN_DIR` lives.

Each stage starts a **fresh** `claude -p` session — no session resume flags, no carrying conversation. This is the isolation property in `spec.md §4.3`.

### D6. Cost accounting

`claude -p` emits usage info on stderr (token counts; cost depends on model pricing). The pipeline driver parses these and appends a row to `run.json` after each stage. Cost = `inputTokens * input_rate + outputTokens * output_rate` using a `MODEL_PRICING` table baked into the worker (Sonnet 4.6 / Opus 4.7 / Haiku 4.5 rates).

Between stages, `pipeline.sh` reads `run.json`, sums `totalCostUsd`, and aborts with exit code 42 if `>= MAX_COST_USD`. The worker treats exit-42 specially: marks `status: aborted-cost`, posts a comment on the issue with the breakdown, moves the task to `failed/`.

### D7. Replay dedupe storage

A small SQLite file at `workspace/state/deliveries.db` with one table `(delivery_id TEXT PRIMARY KEY, seen_at INTEGER)`. On every authenticated webhook, `INSERT OR FAIL` — duplicate → 200 OK with `{ status: 'duplicate' }`. A cron-style cleanup deletes rows older than 24h on each insert (cheap because the table is tiny).

Alternative: in-memory LRU — rejected because receiver restarts would re-open the replay window. SQLite is single-file, zero-config, and the receiver image only needs `better-sqlite3`.

### D8. Branch naming and PR-collision handling

Branch: `agent/<issue-number>-<slug>-<shortTriggerId>` where `slug` is the kebab-cased issue title truncated to 40 chars and `shortTriggerId` is the last 8 chars of `triggerId` (the unix-ms tail). The trailing suffix guarantees branch uniqueness across re-triggers of the same issue without forcing the `spec.md §9` branch-strategy decision into the receiver. Two PRs against the same issue is the v1 behavior.

### D9. Milestone ordering and what "done" means per phase

The 8 phases mirror `spec.md §8` exactly. Each phase has an acceptance test it must pass to be considered done:

| Phase | Acceptance test |
|---|---|
| M1 Skeleton | `docker compose up` brings both containers up; `curl receiver:3000/health` → 200. |
| M2 Receiver | Signed payload → file appears in `pending/`; unsigned → 401; `[bot]` actor → 204; out-of-whitelist repo → 204. |
| M3 Worker stub | The file written in M2's test moves `pending → processing → done` within 2s. |
| M4 Naive Claude | Label a real issue → receive a PR (any quality) within ~5 min; issue gets a comment. |
| M5 Min SDD | Same trigger; `artifacts/` contains `context.json`, `spec.md`, `verdict.txt`; PR body embeds `spec.md`. |
| M6 Challenge stages | `artifacts/` additionally contains `spec-review.md`, `design.md`, `design-review.md`, `tasks.md`. |
| M7 Observability + safety | `run.json` populated with per-stage cost; setting `MAX_COST_USD=0.01` aborts mid-run with an issue comment; replaying a delivery returns dedupe response. |
| M8 Polish | A `processing/` file older than 1h gets moved back to `pending/` on worker startup; README documents how to add/edit a prompt. |

### D10. What we do NOT abstract

No plugin system for trigger sources, no DI container, no command bus, no event-sourcing. Bash + plain files + Express handlers + a polling loop. The architecture is small enough that any of these would be premature.

## Risks / Trade-offs

- **[Prompt injection through issue bodies]** → Mitigations from `spec.md §7.3`: minimum-scope token, fresh session per stage, structured `context.json` between `parse` and downstream stages, independent `verify` stage that fails if the diff edits unrelated files. Residual risk: a clever `parse` prompt could leak instructions into `context.json` itself. Verify is our last line.
- **[Cost overrun before the kill-switch fires]** → Kill-switch only runs *between* stages. A single runaway stage can still spend up to one stage's worth of budget. Per-stage timeout (10 min) caps this; if we see real overruns, add a token-budget flag to `claude -p`.
- **[File queue corruption on volume full / power loss]** → `rename()` is atomic; partial writes land in `.tmp` files and never become visible. Worst case is an orphaned `.tmp` after a crash, which the idle-task sweep ignores. We accept this.
- **[`gh` and `git` CLI version drift inside the worker image]** → Pin both to specific versions in the Dockerfile; document the pin in README so upgrades are explicit.
- **[Claude CLI behavior changes]** → We pin `@anthropic-ai/claude-code` (or equivalent) in the worker image. Treat its CLI surface as a contract; if it changes, that's a deliberate upgrade PR.
- **[Single-worker bottleneck]** → Accepted for v1 (`spec.md §2 NG6`). The atomic-rename claim already lets us scale out when needed; no code change required, just `docker compose up --scale worker=N`.
- **[Webhook delivery during worker downtime]** → Receiver still enqueues; tasks sit in `pending/` until the worker comes back. No data loss as long as the volume survives.

## Migration Plan

Not applicable — this change introduces the project. No prior version exists, no live data to migrate, no users to coordinate. Rollback is `git revert` + `docker compose down -v`.

## Open Questions

Carried forward from `spec.md §9`, unchanged in this design:

- Branch strategy on re-trigger (D8 chooses "always new branch" as the v1 default; revisit if users find it annoying).
- Parallelism (deferred until queue depth becomes a real signal).
- Whether `spec.md` should be versioned (`spec.v1.md` kept beside the revised `spec.md`) — v1 keeps both.
- What partial PASS means in `verify` — v1 is binary.
- MCP servers for richer code context — deferred to v2.

New for this design:

- Exact `claude` CLI invocation flags (model selection, max-tokens, output format). Will be pinned during M4 once we test against the real CLI.
- Whether the receiver should sign its own enqueue (defense against a compromised volume writer). Deferred unless we ever run untrusted code on the same host.