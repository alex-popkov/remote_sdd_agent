# Remote SDD Agent

Self-hosted, event-driven coding agent that turns GitHub Issues into Pull Requests with no human in the loop. Code never leaves the user's infrastructure — the agent runs locally via `docker compose` and only talks to GitHub + Anthropic APIs.

The full specification lives in `spec.md` and is the source of truth. This file is a quick orientation; consult `spec.md` before making non-trivial decisions.

## Core idea: Spec-Driven Development (SDD)

Instead of one large "fix the issue" prompt, work is split into small isolated stages, each driven by a focused, **stack-agnostic subagent** defined in `pipeline/agents/`. Each stage runs in a **fresh Claude session** and reads/writes **artifacts on disk**. The next stage reads those artifacts as input.

Pipeline stages (v1):
`task-researcher → task-planner → plan-challenge → task-executor → task-verifier → specification`

- `plan-challenge` is a fresh `task-planner` session run in critique mode — deliberately adversarial against the plan (the successor to the old `challenge-spec`/`challenge-design` prompt stages). Gated by `ENABLE_PLAN_CHALLENGE`.
- `task-verifier` independently checks the implementation against the plan + acceptance criteria and runs the repo's own build/lint/tests, emitting a `VERDICT: PASS|FAIL`. On `FAIL` the pipeline re-runs the executor up to `MAX_VERIFY_RETRIES` times.
- `specification` (`specification-from-artifacts`) runs only on a `PASS` verdict, writing a committed permanent spec under `.claude/specs/`.

The agents are stack-agnostic: they discover the target repo's language, frameworks, and conventions from the repo itself and its `CLAUDE.md`/skills. PR creation is handled by the worker, not a pipeline stage.

## Architecture

```
GitHub webhook → Receiver (Express/TS) → file queue → Worker (Node + git + gh + claude-code CLI) → PR
```

Two containers wired by a shared volume:

- **`receiver/`** — verifies HMAC, normalizes the event into a `TaskTrigger`, enqueues, ACKs in <100ms. Must respond to GitHub within ~10s.
- **`worker/`** — claims tasks via atomic `rename()`, clones the repo into `/runs/<id>/repo`, runs `pipeline/pipeline.sh`, opens a PR, comments back on the issue.
- **`pipeline/`** — `pipeline.sh` plus stack-agnostic subagents in `pipeline/agents/*.md` (see `pipeline/agents/readme.md`). Bash loop, no orchestration framework.
- **`workspace/`** — shared volume: `queue/{pending,processing,done,failed}` and `runs/<triggerId>/{repo,artifacts,logs,run.json}`. Agents write to `repo/.claude/sdd-tracking/` (symlinked to `artifacts/`); the permanent spec is committed under `repo/.claude/specs/`.

### Why two containers
The receiver must ACK fast; a pipeline run takes 5–30 min. Splitting also lets the receiver restart without losing in-flight work (tasks are files, not memory).

### Why a file queue, not Redis
For a single-developer MVP: simpler, debuggable with `ls`, survives restarts, and `rename()` gives atomic claim semantics. Swap for Redis only when throughput, multi-host, or pub/sub require it.

## Triggers (3 supported)

| Event | Action | Condition | Source |
|---|---|---|---|
| `issues` | `labeled` | label == `TRIGGER_LABEL` (default `agent:run`) | `label` |
| `issue_comment` | `created` | body mentions `@<BOT_MENTION>` | `mention` |
| `issues` | `labeled` | label == `status:ready-for-dev` | `status` |

GitHub Projects v2 status changes are sidestepped via the label convention — their webhook payload requires extra GraphQL queries.

## Non-negotiable rules

These come straight from `spec.md §4.1` and `§7`. Don't relax them without explicit instruction:

1. **HMAC over raw body bytes**, not parsed JSON. Capture via `express.json({ verify: (req,_res,buf) => req.rawBody = buf })`.
2. **`crypto.timingSafeEqual`** for signature comparison — never `===`.
3. **Verify signature before anything else.** Reject in <1ms when invalid.
4. **`ALLOWED_REPOS` whitelist** is mandatory even with a valid signature (defense in depth if the webhook secret leaks).
5. **Filter `sender.login` ending in `[bot]`** — anti-loop guard. Without this, the agent's own comments/PRs/labels retrigger it.
6. **Each pipeline stage = a fresh `claude -p --agent <name>` session.** No state leaks between stages except via files in `repo/.claude/sdd-tracking/`.
7. **One primary output artifact per stage.** Agents live in `pipeline/agents/*.md`; treat agent definitions as data, not code, and keep them stack-agnostic.
8. **`MAX_COST_USD` kill-switch** (default $5) checked between stages — abort and comment on the issue if exceeded.
9. **Dedupe `X-GitHub-Delivery` IDs** in a 24h window to block replay attacks.

## Data contracts (see `spec.md §5` for full types)

- **`TaskTrigger`** — queue payload. `triggerId = "<repo>-<issue>-<unixMs>"` doubles as the run-dir name.
- **SDD artifacts** — markdown under `repo/.claude/sdd-tracking/{research,plans,details,prompts,changes,verification}`. The one machine-parsed contract is the verifier's first line, `VERDICT: PASS|FAIL`, which decides normal vs. draft PR.
- **`run.json`** — per-run metadata: per-stage timings, tokens, cost, exit codes, final status.

## Configuration (`.env`)

Required: `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `ALLOWED_REPOS` (CSV of `owner/name`).
Optional: `TRIGGER_LABEL` (`agent:run`), `BOT_MENTION` (`remote-agent`), `MAX_COST_USD` (`5.00`), `MAX_STAGE_RETRIES` (`3`), `MAX_VERIFY_RETRIES` (`1`), `ENABLE_PLAN_CHALLENGE` (`true`).

## Build order

Milestones in `spec.md §8`: **M1** skeleton → **M2** receiver → **M3** worker stub → **M4** worker + naive Claude call (end-to-end without SDD) → **M5** minimum agent pipeline (researcher → planner → executor → verifier) → **M6** plan-challenge + specification stages → **M7** observability + safety → **M8** polish. Each milestone is independently testable; don't skip ahead.

## Explicitly out of scope for v1

Jira/Linear/Azure boards, Slack triggers, GitHub Projects v2 webhooks, multi-tenancy, a UI, distributed workers. See `spec.md §2` (Non-Goals) before proposing any of these.