# remote-sdd-agent

A self-hosted coding agent that turns **GitHub Issues into Pull Requests**
with no human in the loop. Label an issue, and a few minutes later a PR with
the implementation, a written plan, and a verification report is waiting for
review.

It runs on your own machine with `docker compose`. Your code is cloned and
worked on locally and never leaves your infrastructure: the agent only talks
to the GitHub API (clone, push, PR, comment) and the Anthropic API (the model).

## How it works

Rather than one big "fix this issue" prompt, the agent follows
**Spec-Driven Development (SDD)**. The work is split into small stages, and
each one runs as a **fresh Claude session** with its own focused agent. Stages
don't share conversation state; each reads the previous stage's files on disk
and writes its own.

```
task-researcher → task-planner → plan-challenge → task-executor → task-verifier → specification
                                  (optional)            ↑── verify loop ──┘        (on PASS)
```

| Stage | What it does | Output |
|---|---|---|
| **task-researcher** | Studies the issue and the codebase: stack, conventions, relevant files | research notes |
| **task-planner** | Writes a step-by-step implementation plan | plan + details + implementation prompt |
| **plan-challenge** | A second planner session attacks the plan (gaps, edge cases, risky assumptions) and revises it in place | revised plan |
| **task-executor** | Implements the plan in the repo | code changes + changes log |
| **task-verifier** | Independently checks the result against the plan and the issue, and runs the repo's own build/lint/tests | `VERDICT: PASS` or `FAIL` |
| **specification** | On `PASS`, distills a permanent spec that is committed with the PR | `.claude/specs/…` |

On a `FAIL` verdict the executor gets another try using the verifier's
findings. If it still fails, the PR is opened as a **draft** so a human can
take over. The agents are **stack-agnostic**: they work out the language,
tools, and test commands from the target repo and its `CLAUDE.md`. They live
as plain markdown in [`pipeline/agents/`](./pipeline/agents/).

Every PR description includes the plan, the changes, the spec, and the
verification report. Every run records per-stage tokens and cost, and a
per-run budget (`MAX_COST_USD`, default $5) stops runaway runs.

### Triggers

| You do this on an issue in an allowed repo | Config |
|---|---|
| Add the label `agent:run` | `TRIGGER_LABEL` |
| Add the label `status:ready-for-dev` | fixed |
| Post a comment mentioning `@remote-agent` | `BOT_MENTION` |

Events from repos outside `ALLOWED_REPOS`, events with a bad signature, and
events sent by bots (including the agent itself) are ignored.

## Quick start

For those who've done it before. The full walkthrough follows below.

```bash
cp .env.example .env               # fill in the 4 required values (step 2)
docker compose up --build -d       # start receiver (:3000) + worker
ngrok http 3000                    # expose the receiver; add the repo webhook (step 3)
# → add the `agent:run` label to an issue in an ALLOWED_REPOS repo
docker compose logs -f worker      # watch it work
```

## Prerequisites

- **Docker** with Compose v2 (`docker compose version`) runs both containers.
  Nothing else needs to be installed on the host to run the app.
- **A GitHub repo** you can add a webhook to and label issues on.
- **An Anthropic API key** for the worker's `claude` CLI.
- **`openssl`** to generate the webhook secret (preinstalled on macOS/Linux).
- **A tunnel** (`ngrok` or `cloudflared`) so GitHub can reach the receiver on
  your machine. You don't need it for the local smoke test.
- *Optional, for development:* Node 20+ to run the test suite.

## Run it: step by step

### 1. Create a GitHub token

`GITHUB_TOKEN` is used for everything the worker does on GitHub: clone and
push the agent's branch, read the issue, open the PR (a draft on a `FAIL`
verdict), and comment on the issue. Give it only the repos in
`ALLOWED_REPOS` (`spec.md §7`).

#### Option A: fine-grained PAT (recommended for local use)

Go to <https://github.com/settings/tokens?type=beta>. Under **Repository
access**, choose **Only select repositories** and pick exactly the repos in
`ALLOWED_REPOS`. Set these **Repository permissions**:

| Permission | Level | Why |
|---|---|---|
| **Contents** | Read & write | clone and push the feature branch |
| **Pull requests** | Read & write | `gh pr create` (normal and draft PRs) |
| **Issues** | Read & write | read the issue and labels, comment the PR URL back |
| **Metadata** | Read | required, selected automatically |
| **Workflows** | Read & write | *only if* the agent may edit `.github/workflows/`; pushes that touch workflow files are rejected without it |

#### Option B: GitHub App (best for a long-lived org bot)

Go to <https://github.com/settings/apps/new>. Set the same **Repository
permissions** as the table above, subscribe to the **Issues** and **Issue
comment** events, and install the App on your target repo(s). Use an
installation token as `GITHUB_TOKEN`. Installation tokens expire on their own,
access is per repo, and the App's `[bot]` login is ignored by the anti-loop
guard (`spec.md §4.1`, rule #5).

#### Option C: classic PAT (avoid unless you must)

Go to <https://github.com/settings/tokens/new> and select the **`repo`** scope,
plus **`workflow`** only if the agent may modify `.github/workflows/`. Classic
`repo` grants access to **all** your repositories, so prefer Option A or B.

> The webhook is authenticated with `GITHUB_WEBHOOK_SECRET` (HMAC), not the
> token, so `GITHUB_TOKEN` needs no admin or webhook permission.

### 2. Configure `.env`

```bash
cp .env.example .env
openssl rand -hex 32    # paste the output as GITHUB_WEBHOOK_SECRET
```

Fill in the four required values:

| Variable | Value |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | the random hex string from above (you'll paste it into GitHub in step 3) |
| `GITHUB_TOKEN` | the token from step 1 |
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `ALLOWED_REPOS` | comma-separated `owner/name` list, e.g. `acme/widgets,acme/api` |

The optional settings, with their defaults, are documented inline in
`.env.example`. The ones you're most likely to change:

| Variable | Default | Purpose |
|---|---|---|
| `BASE_BRANCH` | repo default branch | branch to clone, work on, and open the PR against |
| `TRIGGER_LABEL` | `agent:run` | label that starts a run |
| `BOT_MENTION` | `remote-agent` | `@mention` that starts a run from a comment |
| `MAX_COST_USD` | `5.00` | per-run spending cap |
| `MAX_VERIFY_RETRIES` | `1` | executor re-runs after a `FAIL` verdict |
| `ENABLE_PLAN_CHALLENGE` | `true` | run the adversarial plan-review stage |

### 3. Expose the receiver and add the webhook

GitHub has to reach the receiver on port 3000. Start a tunnel:

```bash
ngrok http 3000                                   # or:
cloudflared tunnel --url http://localhost:3000
```

Then, on each repo in `ALLOWED_REPOS`, go to **Settings → Webhooks → Add
webhook** (with a GitHub App, set the same values in the App settings):

| Field | Value |
|---|---|
| **Payload URL** | `https://<your-tunnel>/webhook` |
| **Content type** | **`application/json`** (the default, form-encoded, won't work) |
| **Secret** | the same value as `GITHUB_WEBHOOK_SECRET` |
| **Events** | *Let me select individual events* → **Issues** and **Issue comments** |

Also create the `agent:run` label in the repo (**Issues → Labels → New
label**) so you can apply it. The agent creates its own `agent:created`
label on its PRs.

> Free tunnel URLs change on every restart. When yours does, update the
> Payload URL.

### 4. Start the app

```bash
docker compose up --build
```

This builds and starts two containers:

- **receiver**: listens on `:3000`, checks and filters webhooks, and queues tasks.
- **worker**: picks up queued tasks, runs the pipeline, and opens the PR.

Check that it's up:

```bash
curl localhost:3000/health          # → {"status":"ok"}
```

To run in the background instead, use `docker compose up --build -d` and
follow the logs with `docker compose logs -f`.

> **Always pass `--build` after changing code.** The containers run code
> compiled into the image, so `docker compose up` without `--build` keeps
> running the **old** receiver/worker. Edits to `.env` apply after a plain
> restart. Edits to `pipeline/` (agents and `pipeline.sh`) apply immediately,
> because that directory is mounted into the worker.

### 5. Trigger a run

Add the `agent:run` label to an issue in an allowed repo, or comment
`@remote-agent please take this`. In GitHub's webhook settings, **Recent
Deliveries** should show a `202` response, and the worker log shows:

```
[worker] claimed acme__widgets__42__1717000000000
```

A run takes about 5–30 minutes. When it finishes, the issue gets a comment
linking the new PR. To follow along:

```bash
docker compose logs -f worker
ls workspace/runs/                                  # one directory per run
tail -f workspace/runs/<triggerId>/logs/pipeline.log
jq '.status, .totalCostUsd' workspace/runs/<triggerId>/run.json
```

Each run directory contains the cloned `repo/`, the stage artifacts in
`artifacts/`, one log per stage in `logs/`, and `run.json` with per-stage
timings, tokens, and cost.

### Try it without GitHub: smoke test

To test the receiver → queue → worker path without a tunnel or a webhook
(with the containers running and `.env` filled in):

```bash
bash scripts/smoke-test.sh
```

It sends signed test payloads to the receiver and checks the responses
(202/204/401) and that a task file appears in the queue. The token and API key
can be placeholders for this test.

### Run the tests

No Docker and no API calls: the pipeline tests use a fake `claude`.

```bash
npm install && npm test
```

### Stop and reset

```bash
docker compose down                          # stop both containers
rm -rf workspace/queue/*/*.json workspace/runs/*   # optional: clear the queue and old runs
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
├── worker/          Poll loop, claim, clone, run pipeline, open PR
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
