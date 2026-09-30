## Why

`spec.md` defines a self-hosted, event-driven coding agent that turns GitHub Issues into PRs through a Spec-Driven Development (SDD) pipeline — but the repository today only contains empty `receiver/`, `worker/`, `pipeline/`, and `workspace/` directories plus a stub `docker-compose.yml`. Nothing is wired up yet. The work surface is large (HTTP receiver, file queue, container worker, agent-driven SDD pipeline, security model, cost controls), so building it in one shot is high-risk. We need a single planned change that decomposes the spec into independently-testable phases (M1–M8 in `spec.md §8`) and a corresponding task list, so implementation can start at M1 and each milestone produces a working, demonstrable system.

## What Changes

- **Scaffold the project skeleton (M1)**: directory layout, `docker-compose.yml` with shared volume, `.env.example` covering every config var in `spec.md §6`, README setup steps.
- **Build the receiver (M2)**: Express + TypeScript service exposing `/health` and `/webhook`. HMAC verification over raw body bytes with `timingSafeEqual`, `ALLOWED_REPOS` whitelist, `[bot]` sender filter, normalization of three trigger sources (label, status-label, mention) into a `TaskTrigger`, atomic temp-file + rename enqueue, correct 202/204/401 responses, ack <100ms.
- **Build the worker stub (M3)**: Node + TypeScript polling loop that claims tasks via atomic `rename()`, logs and moves them to `done/` without doing real work — proves end-to-end pipe.
- **Add naive Claude call (M4)**: clone the repo into `/runs/<id>/repo`, run a single `claude -p` call, `gh pr create`, comment back on the issue. No SDD yet — this is the "Simple Remote Agent" baseline.
- **Introduce the SDD pipeline (M5)**: `pipeline/pipeline.sh` bash driver running the minimum agent stages `task-researcher → task-planner → task-executor → task-verifier`, each a fresh `claude -p --agent <name>` session. Agents are stack-agnostic markdown files in `pipeline/agents/`; they read/write artifacts under `repo/.claude/sdd-tracking/` (symlinked to `/runs/<id>/artifacts/`). Per-stage retry budget plus a verify→execute loop on a `FAIL` verdict.
- **Add challenge & specification stages (M6)**: insert the adversarial `plan-challenge` pass (a fresh `task-planner` critique session, gated by `ENABLE_PLAN_CHALLENGE`) and the `specification` stage (`specification-from-artifacts`, run on a `PASS` verdict, writing a committed permanent spec under `.claude/specs/`). PR description includes all agent artifacts.
- **Observability & safety (M7)**: per-run `run.json` with stage timings/tokens/cost, `MAX_COST_USD` enforcement between stages with abort + issue comment, `X-GitHub-Delivery` dedupe (sqlite or in-memory LRU, 24h window).
- **Polish (M8)**: idle-task recovery (move `processing/*.json` older than 1h back to `pending/`), documentation of the agent-tuning workflow.

Non-goals for this change (mirror `spec.md §2`): Jira/Linear/Azure, Slack, GitHub Projects v2 webhooks, multi-tenancy, UI, distributed workers.

## Capabilities

### New Capabilities

- `webhook-receiver`: HTTP entry point that authenticates GitHub webhooks, filters them through the security model (whitelist, bot filter, replay dedupe), normalizes label/status/mention events into a `TaskTrigger`, and enqueues atomically with sub-100ms ack.
- `task-queue`: Filesystem-backed queue under `workspace/queue/{pending,processing,done,failed}` with atomic claim semantics via `rename()`, temp-file write-then-rename enqueue, and idle-task recovery for crashed workers.
- `worker-runner`: Long-running worker that drains the queue, prepares a per-run workspace (`repo/`, `artifacts/`, `logs/`, `run.json`), clones the target repo on a fresh branch, invokes the pipeline, opens a PR via `gh`, comments back on the issue, and moves the task to `done/` or `failed/`.
- `sdd-pipeline`: Bash-driven sequence of isolated, stack-agnostic Claude subagents (`task-researcher → task-planner → plan-challenge → task-executor → task-verifier → specification`), each a fresh `claude -p --agent <name>` session, each producing exactly one primary artifact, with per-stage retry up to `MAX_STAGE_RETRIES` and a verify→execute loop on a `FAIL` verdict. PR creation is handled by the worker, not a pipeline stage.
- `run-observability`: Per-run metadata file (`run.json`) tracking per-stage timings, tokens, exit codes, and cost; cost kill-switch checked between stages that aborts the run and posts a failure comment when `MAX_COST_USD` is exceeded.
- `agent-configuration`: Container packaging (`docker-compose.yml`, per-service Dockerfiles) and environment-variable contract (`.env` / `.env.example`) covering all variables in `spec.md §6`, plus README setup steps.

### Modified Capabilities

(None — `openspec/specs/` is currently empty; this change introduces the first specs.)

## Impact

- **Code**: populates the empty `receiver/`, `worker/`, `pipeline/`, and `workspace/` directories. Adds per-service `Dockerfile`s, replaces the placeholder `docker-compose.yml`, adds `.env.example`, fills out the README.
- **Dependencies**: Node 20+ in both containers; `express`, `typescript`, `tsx`, types for both services; `git` and `gh` CLIs and `@anthropic-ai/claude-code` (or equivalent `claude` CLI) in the worker image; optional `better-sqlite3` for delivery dedupe in the receiver.
- **External systems**: a GitHub App (or fine-grained PAT) with `contents:write`, `issues:write`, `pull_requests:write` on whitelisted repos; an Anthropic API key. Tunnel (ngrok / Cloudflare Tunnel) for dev webhook delivery.
- **Operational surface**: a new shared Docker volume `workspace/` is the durable state — backed by the host filesystem. Logs land in `workspace/runs/<triggerId>/logs/` and process stdout. Cost is bounded per run by `MAX_COST_USD` (default $5).
- **Risk surface**: prompt injection through issue bodies (mitigated by minimal token scope, fresh-session-per-stage, and the independent `task-verifier` stage); webhook forgery (HMAC + whitelist); self-trigger loops (bot-actor filter); replay (delivery-ID dedupe). All called out in `spec.md §7`.
