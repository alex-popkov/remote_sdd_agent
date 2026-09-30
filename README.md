# remote-sdd-agent

A self-hosted remote coding agent: GitHub Issue → SDD pipeline → Pull Request.
Code never leaves your machine — the agent only talks to GitHub + Anthropic.

The architecture, contracts, and security model are documented in
[`spec.md`](./spec.md). Active implementation work lives under
[`openspec/changes/implement-remote-sdd-agent/`](./openspec/changes/implement-remote-sdd-agent/).

## Status

Milestones M1–M8 are implemented. The webhook receiver, file queue and worker
are wired end-to-end, and the worker runs the full agent-based SDD pipeline to
turn a labeled issue into a PR:

```
task-researcher → task-planner → plan-challenge → task-executor → task-verifier → specification
                                  (optional)            ↑── verify loop ──┘        (on PASS)
```

Each stage is a fresh `claude -p --agent <name>` session driven by a
stack-agnostic agent in [`pipeline/agents/`](./pipeline/agents/). A `FAIL`
verdict re-runs the executor (`MAX_VERIFY_RETRIES`) and, if it still fails,
opens the PR as a **draft**. A `PASS` also commits a permanent spec under
`.claude/specs/` in the target repo. Every run records per-stage tokens and
cost in `run.json`, and the `MAX_COST_USD` kill-switch stops runaway runs.

## Prerequisites

Install these before you start:

- **Docker** with Compose v2 (`docker compose version`) — runs both containers.
- **A GitHub account** with admin access to a test repo you can label issues on.
- **An Anthropic API key** — used by the worker's `claude` CLI to run the pipeline.
- **`openssl`** — to generate the webhook secret (preinstalled on macOS/Linux).
- **A tunneling tool** (`ngrok` or `cloudflared`) — to expose your local
  receiver to GitHub. Only needed for the real end-to-end run, not the smoke test.

## Run it — step by step from a clean clone

### 1. Create a GitHub token (App, fine-grained PAT, or classic PAT)

`GITHUB_TOKEN` authenticates every GitHub operation the worker performs:
`git clone` + push the agent's branch, `gh pr create` (including draft PRs on a
`FAIL` verdict), reading the issue body/labels, and `gh issue comment` to post
the PR URL back. Grant the **minimum** that covers those — per `spec.md §7`,
the token should be scoped to the `ALLOWED_REPOS` and unable to read anything
else. Pick one of the three options below.

#### Option A — Fine-grained PAT (simplest, recommended for local use)

Go to <https://github.com/settings/tokens?type=beta>. Under **Repository
access**, choose **Only select repositories** and pick exactly the repos in
`ALLOWED_REPOS`. Set these **Repository permissions**:

| Permission | Level | Why |
|---|---|---|
| **Contents** | Read & write | clone + push the feature branch |
| **Pull requests** | Read & write | `gh pr create` (normal + draft PRs) |
| **Issues** | Read & write | read issue/labels, comment the PR URL back |
| **Metadata** | Read | mandatory, auto-selected |
| **Workflows** | Read & write | *only if* the agent may edit `.github/workflows/` — pushes touching workflow files are rejected without it |

#### Option B — GitHub App (best for a long-lived org bot)

Go to <https://github.com/settings/apps/new>. Set the same **Repository
permissions** as the table above, then subscribe to the **Issues** and
**Issue comment** webhook events and install the App on your target repo(s).
Use an installation token as `GITHUB_TOKEN`. An App is the cleanest fit for a
persistent bot: installation tokens auto-expire, access is per-repo, and the
App's `[bot]` sender login is filtered by the anti-loop guard (`spec.md §4.1`,
rule #5).

#### Option C — Classic PAT (coarse; avoid unless you must)

Go to <https://github.com/settings/tokens/new> and select the **`repo`** scope
(covers clone/push, PRs, and issue comments), plus **`workflow`** only if the
agent may modify `.github/workflows/`. Note that classic `repo` grants access
to **all** your repositories, which conflicts with the per-repo scoping above —
prefer Option A or B.

> The webhook itself is verified with `GITHUB_WEBHOOK_SECRET` (HMAC), not the
> token, so no admin/webhook permission is required on `GITHUB_TOKEN`.

### 2. Copy `.env.example` to `.env` and fill required values

```bash
cp .env.example .env
# Required:
#   GITHUB_WEBHOOK_SECRET   (openssl rand -hex 32)
#   GITHUB_TOKEN            (App installation token or PAT)
#   ANTHROPIC_API_KEY       (only used by the worker pipeline)
#   ALLOWED_REPOS           (comma-separated owner/name)
```

Every variable is documented inline in `.env.example`.

### 3. Start a public tunnel and point the GitHub App webhook at it

```bash
# Pick one:
ngrok http 3000
cloudflared tunnel --url http://localhost:3000
```

In the GitHub App settings:

- **Webhook URL**: `https://<your-tunnel>/webhook`
- **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET` in `.env`

### 4. Start the containers

```bash
docker compose up --build
```

You should see the receiver listening on `:3000` and the worker polling
`/workspace/queue/pending`. Leave this running; open a second terminal for the
verify step. To run detached instead, use `docker compose up --build -d` and
follow logs with `docker compose logs -f`.

> **Always pass `--build` after changing source.** The containers run compiled
> code baked into the image, not the files on disk. `docker compose up -d`
> alone — even with `--force-recreate` — reuses the existing image and silently
> runs **stale code** (e.g. an old worker that prints `would run pipeline` and
> marks tasks `done` without cloning or opening a PR). Editing `.env` does take
> effect on plain recreate, but any change under `receiver/`, `worker/`, or
> `shared/` requires a rebuild: `docker compose up -d --build`.

### 5. Verify end-to-end

Add the `agent:run` label (or whatever `TRIGGER_LABEL` is set to) to any
issue on a whitelisted repo, **or** post a comment containing
`@<BOT_MENTION>`. Watch the worker logs:

```
[worker] claimed acme__widgets__42__1717000000000.json
```

A run takes roughly 5–30 minutes. The worker clones the repo, runs the
pipeline, opens a PR against the issue, and posts a comment on the issue with
the PR URL. Progress per stage is in `workspace/runs/<triggerId>/logs/`
(`pipeline.log` plus one `<stage>.log` each), and cost so far in
`workspace/runs/<triggerId>/run.json`.

### Fast path: smoke test without GitHub

To exercise the receiver → queue → worker pipe with no GitHub App or tunnel,
run (with `docker compose up` already running and `.env` populated):

```bash
bash scripts/smoke-test.sh
```

It signs local payloads with your webhook secret and checks the receiver's
response codes (202/204/401) and that a queue file appears in `pending/`.

Unit and integration tests (no Docker, no API calls — the pipeline tests use a
fake `claude`):

```bash
npm install && npm test
```

### Stopping and resetting

```bash
docker compose down            # stop both containers
rm -rf workspace/queue/* workspace/runs/*   # clear queue + run dirs (optional)
```

## Architecture (one paragraph)

```
GitHub  ──webhook──►  receiver  ──file──►  workspace/queue/pending  ──poll──►  worker
                                                                                  │
                                                                                  ▼
                                                                       pipeline.sh → PR
```

Two containers, one shared `/workspace` volume. Receiver ACKs in <100ms;
worker does long-running work independently. File-per-task queue uses
POSIX `rename()` for atomic claim — no locks, scales to multiple workers
later. See [`spec.md`](./spec.md) for the full architecture, security
model, and milestone breakdown.

## Project layout

```
.
├── docker-compose.yml
├── .env.example
├── receiver/        Express + HMAC verify + filters + enqueue
├── worker/          Poll loop, claim, (M4+) clone + run pipeline
├── shared/          Shared TypeScript types (TaskTrigger, Context, RunMetadata)
├── pipeline/        pipeline.sh + stack-agnostic agents (pipeline/agents/*.md)
├── docs/            agent-tuning.md
├── scripts/         smoke-test.sh
├── openspec/        Active change proposals and per-capability specs
└── workspace/
    ├── queue/       pending / processing / done / failed
    ├── runs/        Per-task working directories
    └── state/       Receiver delivery-dedupe DB (deliveries.db)
```

## Cost kill-switch

`MAX_COST_USD` (default `5.00`) caps what one run may spend. After each stage
the pipeline prices the stage's token usage (from `claude -p --output-format
json`, using the table in `worker/src/pricing.ts`) and adds it to
`run.json.totalCostUsd`. Between stages, once the total reaches the ceiling the
pipeline exits with code 42 and the worker:

- sets `run.json.status = "aborted-cost"` with a per-stage breakdown in
  `failureReason`,
- posts that breakdown as a comment on the source issue,
- opens no PR and moves the task to `workspace/queue/failed/`.

A check only happens *between* stages, so a run can overshoot the ceiling by at
most one stage's cost. A typical green run costs a few dollars; see
[`docs/agent-tuning.md`](./docs/agent-tuning.md) for how to read per-stage
cost and cut it.

## Recovering a failed run

A failed task lands in `workspace/queue/failed/<triggerId>.json` and its run
directory `workspace/runs/<triggerId>/` is preserved for postmortem: start with
`run.json` (`status`, `failureReason`) and `logs/pipeline.log`, then the
failing stage's `logs/<stage>.log`.

`status` tells you what happened:

| `status` | Meaning | What to do |
|---|---|---|
| `failed` | A core stage produced no artifact after `MAX_STAGE_RETRIES`, the diff was empty, or `git`/`gh` failed | Fix the cause, then retry |
| `aborted-cost` | The run hit `MAX_COST_USD` | Raise the ceiling in `.env` or tune the costly stage, then retry |

To retry, move the task file back to the queue. The run directory is keyed by
the trigger id, so move the old one aside first — the worker clones into a
fresh `repo/`:

```bash
ID=<triggerId>
mv workspace/runs/$ID workspace/runs/$ID.failed-$(date +%s)
mv workspace/queue/failed/$ID.json workspace/queue/pending/
```

Or simply re-trigger the issue (re-add the label or mention the bot) — that
creates a new trigger id and a new branch/PR.

**Crashed worker.** If the worker dies mid-run, its task is stuck in
`workspace/queue/processing/`. On the next start the worker moves any
`processing/` file claimed more than 1 hour ago back to `pending/`, marks the
abandoned run `failed` and renames its directory to
`runs/<triggerId>.abandoned-<unixMs>`, then re-runs the task from scratch.

## Further reading

- [`spec.md`](./spec.md) — architecture, data contracts, security model, milestones.
- [`openspec/changes/implement-remote-sdd-agent/`](./openspec/changes/implement-remote-sdd-agent/) — the implementation change: proposal, design decisions, per-capability specs, task list.
- [`docs/agent-tuning.md`](./docs/agent-tuning.md) — editing agents, re-running one stage, inspecting cost.
- [`pipeline/agents/readme.md`](./pipeline/agents/readme.md) — what each agent does.
