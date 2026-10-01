## ADDED Requirements

### Requirement: Platform selection per deployment

The system SHALL select exactly one platform per deployment from the `PLATFORM` environment variable, defaulting to `github` when unset. The same platform SHALL provide both the repository host and the task tracker. Both the receiver and the worker SHALL resolve the platform at startup, and an unsupported value SHALL make the container exit non-zero with a message naming the supported values.

#### Scenario: Default platform

- **WHEN** the receiver and worker start with `PLATFORM` unset
- **THEN** both use the GitHub platform

#### Scenario: Unsupported platform fails fast

- **WHEN** either container starts with `PLATFORM=gitlab`
- **THEN** it exits non-zero at startup and the error message lists `github` as a supported value

### Requirement: Platform interfaces

The system SHALL define three platform interfaces:

- `WebhookAdapter` (used by the receiver): verifies the request signature over the raw body, extracts the delivery ID, detects bot senders, extracts the target repository, and maps an event to a `TaskTrigger` (including any platform-specific trusted-author checks).
- `RepoProvider` (used by the worker): clones the target repository, provides the commit identity, pushes a branch, and opens a pull request, returning its URL.
- `TaskTracker` (used by the worker): comments on the source task and provides the closing-reference text and the task display name.

The worker-side platform SHALL also expose `secretEnvNames`, the environment variables that must be withheld from agent sessions.

#### Scenario: Worker uses only the interfaces

- **WHEN** the worker processes a task
- **THEN** clone, push, pull-request creation and task comments go through `RepoProvider` and `TaskTracker`, and no worker task-flow module invokes `gh` or builds a platform URL directly

#### Scenario: Receiver uses only the adapter

- **WHEN** the receiver handles a webhook request
- **THEN** signature verification, delivery-ID extraction, bot detection, repo extraction and event mapping are performed by the `WebhookAdapter`

### Requirement: Per-container factories with least-privilege credentials

The receiver SHALL obtain its `WebhookAdapter` from a receiver-side factory, and the worker SHALL obtain its `RepoProvider`, `TaskTracker` and `secretEnvNames` from a worker-side factory, both keyed by the same `PLATFORM` value. Each factory SHALL read and validate only the credentials its container needs.

#### Scenario: Receiver needs only the webhook secret

- **WHEN** the receiver starts with `PLATFORM=github`, `GITHUB_WEBHOOK_SECRET` set and `GITHUB_TOKEN` unset
- **THEN** it starts successfully

#### Scenario: Worker needs only the API token

- **WHEN** the worker starts with `PLATFORM=github`, `GITHUB_TOKEN` set and `GITHUB_WEBHOOK_SECRET` unset
- **THEN** it starts successfully

#### Scenario: Missing platform credential fails fast

- **WHEN** the worker starts with `PLATFORM=github` and `GITHUB_TOKEN` unset
- **THEN** it exits non-zero with a message naming `GITHUB_TOKEN`

### Requirement: Adapter resolves the target repository

A non-null `TaskTrigger` returned by a `WebhookAdapter` SHALL always contain the target repository (`repo.owner`, `repo.name`). How the repository is determined SHALL be the platform's responsibility; the core SHALL NOT contain platform-specific repo-resolution logic.

#### Scenario: GitHub resolves the repo from the payload

- **WHEN** the GitHub adapter maps an `issues.labeled` event for `repository.full_name = "acme/api"`
- **THEN** the resulting trigger has `repo = { owner: "acme", name: "api" }`

### Requirement: Platform-specific task text

Text that refers to the source task SHALL come from the `TaskTracker`: the closing reference used in the commit message, PR title and PR body, and the task display name used in the PR body and passed to the pipeline as `TASK_DISPLAY_NAME`.

#### Scenario: GitHub text is unchanged

- **WHEN** the worker opens a PR for GitHub issue #16 titled "Remove filters"
- **THEN** the PR title is `Remove filters (closes #16)`, the commit message is `agent: Remove filters (closes #16)`, and the pipeline receives `TASK_DISPLAY_NAME="GitHub issue #16"`

### Requirement: GitHub platform preserves current behavior

The GitHub platform SHALL reproduce the system's behavior before this change: HMAC-SHA256 verification of `X-Hub-Signature-256` over the raw body with a timing-safe comparison, `X-GitHub-Delivery` as the delivery ID, `[bot]`-suffix bot detection, the three trigger mappings (label, status label, trusted-author mention), token-free clone remotes with header-based git auth, `gh`-based pull requests with the `agent:created` label and draft-on-FAIL, and `gh`-based issue comments. `TaskTrigger`, the queue file format and the `triggerId` format SHALL be unchanged.

#### Scenario: Existing behavior tests pass

- **WHEN** the pre-existing receiver and worker test cases are run against the GitHub platform
- **THEN** they pass with unchanged assertions

#### Scenario: Queued tasks remain compatible

- **WHEN** a worker built from this change claims a task file enqueued by the previous receiver version
- **THEN** it processes the task normally
