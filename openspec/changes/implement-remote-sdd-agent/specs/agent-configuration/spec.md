## ADDED Requirements

### Requirement: Environment variable contract

The system SHALL accept the following environment variables, with the listed defaults applied when the variable is unset:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | — | HMAC secret shared with the GitHub App/webhook configuration |
| `GITHUB_TOKEN` | yes | — | Token used for `git clone` and `gh` CLI |
| `ANTHROPIC_API_KEY` | yes | — | Authentication for the `claude` CLI |
| `ALLOWED_REPOS` | yes | — | Comma-separated `owner/name` whitelist |
| `TRIGGER_LABEL` | no | `agent:run` | Label whose addition fires the agent |
| `BOT_MENTION` | no | `remote-agent` | Mention string (without leading `@`) recognized in comments |
| `MAX_COST_USD` | no | `5.00` | Per-run cost ceiling enforced between stages |
| `MAX_STAGE_RETRIES` | no | `3` | Per-stage retry budget |

A missing required variable SHALL cause the affected container to exit non-zero on startup with a message naming the missing variable. Defaults SHALL only be applied when the variable is unset (not when it is set to an empty string).

#### Scenario: Missing required variable fails fast

- **WHEN** the receiver starts with `GITHUB_WEBHOOK_SECRET` unset
- **THEN** it exits non-zero within 1 second and prints `"GITHUB_WEBHOOK_SECRET is required"` (or equivalent)

#### Scenario: Default applies when variable is unset

- **WHEN** the worker starts with `MAX_COST_USD` unset
- **THEN** the effective ceiling is `$5.00`

#### Scenario: Empty string overrides default

- **WHEN** the worker starts with `MAX_COST_USD=""`
- **THEN** the worker fails fast (an explicit empty value is not a valid amount)

### Requirement: docker-compose wiring

The project SHALL provide a `docker-compose.yml` that defines exactly two services for v1 — `receiver` and `worker` — sharing a single named volume `workspace` mounted at `/workspace` in both containers. The receiver SHALL publish its HTTP port (default 3000) to the host. Both services SHALL read environment variables via `env_file: .env`.

#### Scenario: Compose brings both services up

- **WHEN** a user with a valid `.env` runs `docker compose up`
- **THEN** both `receiver` and `worker` containers reach a running state and share `/workspace`

#### Scenario: Workspace is durable across restarts

- **WHEN** a user runs `docker compose down` (without `-v`) and then `docker compose up`
- **THEN** existing files under `workspace/queue/` and `workspace/runs/` are preserved

### Requirement: .env.example documents every variable

The project SHALL include a `.env.example` file at the repo root listing every variable from the environment-variable contract above, each with an inline comment describing its purpose and (for optional vars) noting the default.

#### Scenario: Example file is copy-ready

- **WHEN** a new user runs `cp .env.example .env` and fills in the required values
- **THEN** the resulting `.env` is sufficient to start `docker compose up`

### Requirement: README setup steps

The project README SHALL document the end-to-end setup, in order: (1) create a GitHub App or fine-grained PAT with the required scopes, (2) copy `.env.example` to `.env` and populate values, (3) start a tunnel (ngrok or Cloudflare Tunnel) and configure the webhook URL in the GitHub App, (4) run `docker compose up`, (5) verify with a label or `@<BOT_MENTION>` comment on a whitelisted repo.

#### Scenario: README covers the setup path

- **WHEN** a new user follows the README from a clean clone
- **THEN** they can complete steps 1–5 without consulting other documents
