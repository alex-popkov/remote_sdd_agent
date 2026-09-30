## ADDED Requirements

### Requirement: HMAC signature verification over raw body

The receiver SHALL verify every incoming `/webhook` request against the `X-Hub-Signature-256` header using HMAC-SHA256 keyed with `GITHUB_WEBHOOK_SECRET`, computed over the **raw request body bytes** (not parsed or re-stringified JSON). Comparison SHALL use `crypto.timingSafeEqual` against equal-length buffers. The check SHALL run before any business logic, and invalid requests SHALL be rejected with `401 Unauthorized` without parsing or logging the body.

#### Scenario: Valid signature is accepted

- **WHEN** GitHub posts to `/webhook` with a body and header `X-Hub-Signature-256: sha256=<correct-digest>`
- **THEN** the receiver proceeds to event handling and responds within 100ms

#### Scenario: Invalid signature is rejected

- **WHEN** a client posts to `/webhook` with a body and header `X-Hub-Signature-256: sha256=<wrong-digest>`
- **THEN** the receiver responds `401 Unauthorized` in <1ms and does not enqueue, log the body, or call downstream code

#### Scenario: Missing signature header is rejected

- **WHEN** a client posts to `/webhook` without `X-Hub-Signature-256`
- **THEN** the receiver responds `401 Unauthorized`

#### Scenario: Comparison uses constant-time equality

- **WHEN** the receiver compares the computed and provided digests
- **THEN** it uses `crypto.timingSafeEqual` on equal-length `Buffer`s, never `===` or `Buffer.compare`

### Requirement: ALLOWED_REPOS whitelist enforcement

The receiver SHALL extract `repository.full_name` from authenticated payloads and SHALL drop events whose repo is not present in the `ALLOWED_REPOS` comma-separated whitelist, even if the signature is valid. Dropped events SHALL respond `204 No Content`.

#### Scenario: Event for whitelisted repo proceeds

- **WHEN** a valid-signature payload arrives for repo `owner/name` and `ALLOWED_REPOS` includes `owner/name`
- **THEN** the receiver continues normal handling

#### Scenario: Event for non-whitelisted repo is dropped

- **WHEN** a valid-signature payload arrives for repo `evil/repo` and `ALLOWED_REPOS` does not include `evil/repo`
- **THEN** the receiver responds `204 No Content` and does not enqueue

### Requirement: Anti-loop filter on bot senders

The receiver SHALL drop any event whose `sender.login` ends with `[bot]`, regardless of event type or trigger conditions. Dropped events SHALL respond `204 No Content`.

#### Scenario: Bot-actor event is dropped

- **WHEN** a valid payload arrives with `sender.login: "remote-agent[bot]"`
- **THEN** the receiver responds `204 No Content` and does not enqueue

#### Scenario: Human-actor event proceeds

- **WHEN** a valid payload arrives with `sender.login: "alice"`
- **THEN** the receiver continues to event-mapping

### Requirement: Trigger mapping from three event sources

The receiver SHALL normalize three GitHub event shapes into a single `TaskTrigger` payload, and SHALL respond `204 No Content` for any other event/action combination:

| GitHub event | Action | Condition | `source` field |
|---|---|---|---|
| `issues` | `labeled` | `label.name === TRIGGER_LABEL` | `label` |
| `issues` | `labeled` | `label.name === 'status:ready-for-dev'` | `status` |
| `issue_comment` | `created` | comment body contains `@<BOT_MENTION>` | `mention` |

#### Scenario: Trigger label fires a label-source trigger

- **WHEN** an `issues.labeled` event arrives with `label.name === TRIGGER_LABEL`
- **THEN** a `TaskTrigger` is built with `source: 'label'` and enqueued

#### Scenario: Status label fires a status-source trigger

- **WHEN** an `issues.labeled` event arrives with `label.name === 'status:ready-for-dev'`
- **THEN** a `TaskTrigger` is built with `source: 'status'` and enqueued

#### Scenario: Bot mention fires a mention-source trigger

- **WHEN** an `issue_comment.created` event arrives whose body contains `@<BOT_MENTION>`
- **THEN** a `TaskTrigger` is built with `source: 'mention'` and enqueued

#### Scenario: Unrelated event is acknowledged but not enqueued

- **WHEN** an authenticated event arrives that matches no trigger rule (e.g., `pull_request.opened`)
- **THEN** the receiver responds `204 No Content`

### Requirement: TaskTrigger payload shape

When enqueueing, the receiver SHALL construct a `TaskTrigger` object conforming to `spec.md §5.1` with `triggerId = "<owner>__<repo>__<issue>__<unixMs>"`, and SHALL write it as JSON to `workspace/queue/pending/<triggerId>.json`.

#### Scenario: Enqueued payload conforms to the type

- **WHEN** the receiver enqueues a trigger for issue #42 of `acme/widgets` at unix ms `1717000000000`
- **THEN** the file `workspace/queue/pending/acme__widgets__42__1717000000000.json` exists and contains fields `triggerId`, `source`, `repo.owner`, `repo.name`, `issue.number`, `issue.title`, `issue.body`, `issue.url`, `issue.author`, `actor`, and `raw.event`

### Requirement: Atomic enqueue via temp-file plus rename

The receiver SHALL enqueue by writing to a hidden temp file `workspace/queue/pending/.<triggerId>.json.tmp` and then atomically `rename()`ing it to `workspace/queue/pending/<triggerId>.json`. A reader scanning `pending/` SHALL never observe a partially-written file.

#### Scenario: Crash mid-write leaves no visible task

- **WHEN** the receiver process is killed between opening the temp file and the rename
- **THEN** no file matching `pending/*.json` (non-hidden) is observable; only an orphan `.tmp` may remain

### Requirement: Acknowledgement timing and response codes

The receiver SHALL respond with the following status codes and SHALL ack within 100ms of receiving the request:

- `202 Accepted` with body `{ triggerId }` when a trigger is enqueued
- `204 No Content` when the signature is valid but the event is not a trigger (including bot, non-whitelisted repo, and unmapped events)
- `401 Unauthorized` when signature verification fails
- `500 Internal Server Error` when the signature was valid but enqueue failed

#### Scenario: Successful enqueue responds 202 with triggerId

- **WHEN** a trigger is successfully enqueued
- **THEN** the response is `202 Accepted` with JSON body `{ "triggerId": "<id>" }` within 100ms

#### Scenario: Enqueue failure responds 500

- **WHEN** the temp file cannot be written (e.g., volume read-only)
- **THEN** the receiver responds `500 Internal Server Error`

### Requirement: Health endpoint

The receiver SHALL expose `GET /health` returning `200 OK` with body `{ "status": "ok" }` for use by `docker compose` healthchecks and human probes.

#### Scenario: Health probe succeeds

- **WHEN** any client requests `GET /health`
- **THEN** the receiver responds `200 OK` with `{ "status": "ok" }` without auth

### Requirement: Replay protection via X-GitHub-Delivery dedupe

The receiver SHALL record each authenticated request's `X-GitHub-Delivery` header value in a 24-hour deduplication store and SHALL drop any request whose delivery ID has been seen within the window, responding with `200 OK` and body `{ "status": "duplicate" }`.

#### Scenario: First occurrence of a delivery ID is processed

- **WHEN** a valid signed request arrives with `X-GitHub-Delivery: abc-123` that is not in the store
- **THEN** the receiver processes the event normally and records `abc-123` with the current timestamp

#### Scenario: Replayed delivery ID is dropped

- **WHEN** a request arrives with `X-GitHub-Delivery: abc-123` that was seen <24h ago
- **THEN** the receiver responds `200 OK` with `{ "status": "duplicate" }` and does not enqueue

#### Scenario: Delivery IDs older than 24h are forgotten

- **WHEN** the dedupe store is queried
- **THEN** entries with `seen_at` older than 24 hours SHALL be eligible for cleanup and no longer block replays