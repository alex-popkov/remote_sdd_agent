## Why

Every platform touchpoint is hardcoded to GitHub: webhook verification and payload parsing in the receiver, `git clone`/`gh pr create`/`gh issue comment` in the worker, the `"closes #N"` / `"GitHub issue #N"` text, and the list of secrets withheld from agent sessions. Supporting another code-hosting platform (GitLab, Azure DevOps, …) later would mean editing code across both containers. Introducing a single platform seam now — while GitHub is the only implementation — keeps that future change local to one new module, without implementing any other platform in v1.

## What Changes

- Introduce a `Platform` abstraction made of three parts plus secret metadata:
  - `WebhookAdapter` (receiver): signature verification, delivery ID, bot detection, trusted-author check, repo extraction, event → `TaskTrigger` mapping.
  - `RepoProvider` (worker): clone, push, open pull request.
  - `TaskTracker` (worker): comment on the task, closing reference text, task display name.
  - `secretEnvNames`: env vars the platform needs that must be withheld from agent sessions.
- Add a factory `createPlatform(config)` selected by a new `PLATFORM` env var (default `github`). An unknown value fails at startup. The repo host and the task tracker are **always the same platform** for a deployment.
- Move the existing GitHub code behind these interfaces as `GitHubPlatform`. This is a refactor: **no observable behavior change** for GitHub deployments.
- The receiver keeps ownership of the security order (verify signature → dedupe → bot filter → allowlist → map → enqueue) and calls the platform's hooks for each step. `ALLOWED_REPOS` is always checked on the repo the adapter resolves.
- The webhook route becomes `POST /webhook/<platform>` (e.g. `/webhook/github`); `POST /webhook` remains as an alias so existing GitHub webhook configurations keep working.
- The worker's agent-environment scrubbing uses the platform's `secretEnvNames` instead of a hardcoded list.
- `TaskTrigger`, the queue file format and the `triggerId` format are **unchanged**.
- Only GitHub is implemented. Other platforms remain out of scope for v1 (`spec.md` §2 NG1); `spec.md` gets a note describing the seam.

## Capabilities

### New Capabilities
- `platform-abstraction`: the `Platform` interfaces, the `PLATFORM`-keyed factory, the same-platform rule, the "adapter must resolve a repo" contract, and the GitHub implementation.

### Modified Capabilities
- `webhook-receiver`: webhook route becomes `/webhook/<platform>` with `/webhook` as alias; signature, delivery-ID, bot and mapping checks are delegated to the platform adapter while the receiver keeps the fixed check order.
- `worker-runner`: clone/push/PR/comment go through `platform.repo` and `platform.tracker`; the secrets withheld from agent sessions come from `platform.secretEnvNames`.
- `agent-configuration`: new optional `PLATFORM` variable (default `github`).

## Impact

- **Code**: new `shared/src/platform/` (interfaces, factory) and `shared/src/platform/github/` (moved from `receiver/src/verifySignature.ts`, `receiver/src/triggerMap.ts`, `receiver/src/filters/*`, `worker/src/gitOps.ts` remote parts, `worker/src/prCreate.ts`, `worker/src/notify.ts`). `receiver/src/app.ts`, `receiver/src/config.ts`, `worker/src/main.ts`, `worker/src/config.ts`, `worker/src/exec.ts`, `worker/src/pipeline.ts` updated to use the platform.
- **Pipeline**: `pipeline.sh` receives the task display name from the worker instead of hardcoding `"GitHub issue #N"`.
- **Config**: `.env.example`, README and `spec.md` document `PLATFORM`. Existing `.env` files keep working unchanged.
- **Tests**: existing receiver/worker tests move with the code they cover; new tests for the factory and route alias. `scripts/smoke-test.sh` continues to pass against `/webhook`.
- **Dependencies**: none added.
- **Depends on**: the in-progress (uncommitted) secret-isolation work in `worker/src/exec.ts` should land first, since this change replaces its hardcoded withheld-env list.
