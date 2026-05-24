# remote-agent

A self-hosted remote coding agent: GitHub Issue → SDD pipeline → Pull Request.
Inspired by Wix's "Nota" architecture.

## Day 1 status

This is the foundation: webhook receiver + worker skeleton + queue. No Claude
calls happen yet — the worker just logs claimed tasks. Day 2 wires in the
SDD pipeline.

## Setup

### 1. Copy env

```bash
cp .env.example .env
# Fill in GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN, ANTHROPIC_API_KEY, ALLOWED_REPOS
```

Generate a secret:
```bash
openssl rand -hex 32
```

### 2. Build & run

```bash
docker compose up --build
```

You should see:
```
remote-agent-receiver  | Receiver listening on :3000
remote-agent-worker    | [worker] polling /queue/pending every 5000ms
```

### 3. Expose locally (pick one)

**ngrok:**
```bash
ngrok http 3000
```

**Cloudflare Tunnel (no signup, recommended):**
```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the public URL — you'll paste it into your GitHub App next.

### 4. Create a GitHub App

Go to: <https://github.com/settings/apps/new>

- **Webhook URL**: `https://<your-tunnel>/webhook`
- **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET` in `.env`
- **Permissions** (Repository):
  - Contents: Read & write
  - Issues: Read & write
  - Pull requests: Read & write
  - Metadata: Read (auto)
- **Subscribe to events**: Issues, Issue comment
- Install the app on your target repo(s)

### 5. Smoke test

In your test repo, add the `agent:run` label to any issue. Watch the worker
logs — you should see:

```
[worker] claimed remote-agent-test-42-1716...json
[worker] would run pipeline for you/your-repo issue #42 (source=label)
```

If the receiver logs `Rejected webhook: invalid signature` — your secrets
don't match. If you see `Ignored issues` — the label name didn't match
`TRIGGER_LABEL`.

## Local test without GitHub

You can hit the receiver directly with a properly signed payload:

```bash
SECRET="$(grep GITHUB_WEBHOOK_SECRET .env | cut -d= -f2)"
BODY='{"action":"labeled","repository":{"name":"test","owner":{"login":"me"},"full_name":"me/test"},"issue":{"number":1,"title":"x","body":"y","html_url":"https://x","user":{"login":"me"}},"label":{"name":"agent:run"},"sender":{"login":"me"}}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-GitHub-Delivery: test-1" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

Add `me/test` to `ALLOWED_REPOS` in `.env` for this to pass the safety net.

## Architecture

```
GitHub  ──webhook──►  receiver  ──file──►  /queue/pending  ──poll──►  worker
                                                                        │
                                                                        ▼
                                                                  (Day 2: pipeline)
```

Two containers, one shared volume. Receiver responds <100ms; worker does
the long-running stuff independently. File-per-task queue uses POSIX
`rename()` for atomic claim — no locks, scales to multiple workers later.

## Project layout

```
.
├── docker-compose.yml
├── .env.example
├── receiver/        # Express + HMAC verify + normalize + enqueue
├── worker/          # Poll loop, claim, (TODO) run pipeline
├── pipeline/        # bash + prompts (Day 2)
└── workspace/
    ├── queue/       # pending / processing / done / failed
    └── runs/        # per-task working directories
```
