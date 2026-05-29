# remote-sdd-agent

A self-hosted remote coding agent: GitHub Issue → SDD pipeline → Pull Request.
Code never leaves your machine — the agent only talks to GitHub + Anthropic.

The architecture, contracts, and security model are documented in
[`spec.md`](./spec.md). Active implementation work lives under
[`openspec/changes/implement-remote-sdd-agent/`](./openspec/changes/implement-remote-sdd-agent/).

## Status

Day 1: webhook receiver + worker skeleton + file queue. The worker claims
tasks but does not yet run the SDD pipeline. Subsequent milestones (M4–M8)
wire in cloning, Claude calls, the staged pipeline, and the cost kill-switch.

## Setup — 5 steps from a clean clone

### 1. Create a GitHub App (or a fine-grained PAT)

Go to <https://github.com/settings/apps/new>. Required permissions on the
repos the agent will work on:

- **Contents**: Read & write
- **Issues**: Read & write
- **Pull requests**: Read & write
- **Metadata**: Read (auto)

Subscribe to: **Issues**, **Issue comment**. Install on your target repo(s).
A fine-grained PAT with the same scopes also works for purely local testing.

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
`/workspace/queue/pending`.

### 5. Verify end-to-end

Add the `agent:run` label (or whatever `TRIGGER_LABEL` is set to) to any
issue on a whitelisted repo, **or** post a comment containing
`@<BOT_MENTION>`. Watch the worker logs:

```
[worker] claimed acme__widgets__42__1717000000000.json
```

For a no-GitHub smoke test, run `bash scripts/smoke-test.sh` — it signs
local payloads with your webhook secret and exercises the four response
codes (202/204/401 + queue file appearance).

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