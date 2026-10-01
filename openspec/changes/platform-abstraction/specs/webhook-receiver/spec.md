## ADDED Requirements

### Requirement: Platform webhook route with legacy alias

The receiver SHALL accept webhooks at `POST /webhook/<platform>` for the configured platform (e.g. `POST /webhook/github`) and SHALL handle `POST /webhook` identically as an alias. Requests to a route for a platform other than the configured one SHALL receive `404 Not Found`.

#### Scenario: Platform route accepts a trigger

- **WHEN** a correctly signed label-trigger event for a whitelisted repo is posted to `/webhook/github` with `PLATFORM=github`
- **THEN** the receiver responds `202 Accepted` with `{ "triggerId": "<id>" }`

#### Scenario: Legacy route still works

- **WHEN** the same request is posted to `/webhook`
- **THEN** the receiver responds `202 Accepted`

#### Scenario: Other platform's route is not mounted

- **WHEN** a request is posted to `/webhook/gitlab` with `PLATFORM=github`
- **THEN** the receiver responds `404 Not Found` and enqueues nothing

### Requirement: Receiver enforces the check order across platforms

The receiver SHALL run the platform adapter's checks in this fixed order, regardless of platform: signature verification (401 on failure, before any other processing), delivery-ID dedupe, bot-sender filter, `ALLOWED_REPOS` check on the adapter-resolved repository, event mapping, then enqueue. Before enqueueing, the receiver SHALL re-check that the trigger's `repo` is in `ALLOWED_REPOS` and SHALL drop the event with `204 No Content` if it is not.

#### Scenario: Invalid signature short-circuits

- **WHEN** a request with an invalid signature arrives on the platform route
- **THEN** the receiver responds `401` without consulting the dedupe store or parsing the payload into a trigger

#### Scenario: Trigger repo disagreeing with the allowlist is dropped

- **WHEN** an adapter's `repoOf` returns a whitelisted repo but its `toTrigger` returns a trigger for a non-whitelisted repo
- **THEN** the receiver responds `204 No Content` and enqueues nothing
