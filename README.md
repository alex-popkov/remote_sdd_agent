# remote-sdd-agent

A self-hosted remote coding agent: GitHub Issue → SDD pipeline → Pull Request.
Code never leaves your machine — the agent only talks to GitHub + Anthropic.

The architecture, contracts, and security model are documented in
[`spec.md`](./spec.md). Active implementation work lives under
[`openspec/changes/implement-remote-sdd-agent/`](./openspec/changes/implement-remote-sdd-agent/).

## Status

Webhook receiver + file queue + worker are wired end-to-end, and the worker
runs the agent-based SDD pipeline (`task-researcher → task-planner →
task-executor → task-verifier`) to turn a labeled issue into a PR. Remaining
milestones (M6–M8) add the plan-challenge + specification stages,
observability, and the cost kill-switch.

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

Within ~5 minutes the worker clones the repo, runs the pipeline, opens a PR
against the issue, and posts a comment on the issue with the PR URL.

### Fast path: smoke test without GitHub

To exercise the receiver → queue → worker pipe with no GitHub App or tunnel,
run (with `docker compose up` already running and `.env` populated):

```bash
bash scripts/smoke-test.sh
```

It signs local payloads with your webhook secret and checks the receiver's
response codes (202/204/401) and that a queue file appears in `pending/`.

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
                                                                       pipeline.sh (M5+)
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
├── pipeline/        bash + prompts (M5+)
├── scripts/         smoke-test.sh
├── openspec/        Active change proposals and per-capability specs
└── workspace/
    ├── queue/       pending / processing / done / failed
    ├── runs/        Per-task working directories
    └── state/       Receiver dedupe DB (M7+)
```

## Recovering a failed run

A failed task lands in `workspace/queue/failed/<triggerId>.json` and its
run directory `workspace/runs/<triggerId>/` is preserved for postmortem.
To retry, move the file back to `workspace/queue/pending/`. The cost
kill-switch (`MAX_COST_USD`, default $5/run) trips between pipeline
stages — runs aborted that way land in `failed/` with `run.json.status =
"aborted-cost"`.