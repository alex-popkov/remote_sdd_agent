## 0. Prerequisite

- [x] 0.1 Commit the pending secret-isolation work (`worker/src/{exec,gitOps,prCreate,claudeCall,pipeline}.ts`, `worker/test/secretIsolation.test.ts`) so this change starts from a clean tree

## 1. Shared platform contract

- [ ] 1.1 Add `shared/src/platform/types.ts` with `PlatformName`, `IncomingHeaders`, `RepoRef`, `WebhookAdapter`, `RepoProvider`, `TaskTracker`, `WorkerPlatform` (design D2)
- [ ] 1.2 Add `SUPPORTED_PLATFORMS` and `parsePlatform(env)` (default `github`, fail-fast message listing supported values) in `shared/src/platform/index.ts`
- [ ] 1.3 Add the shared `timingSafeEqualStrings` helper (length-safe wrapper around `crypto.timingSafeEqual`)
- [ ] 1.4 Re-export the platform contract from `shared/src/index.ts`

## 2. Receiver: GitHub webhook adapter

- [ ] 2.1 Create `receiver/src/platform/github/` and move `verifySignature.ts`, `triggerMap.ts` and `filters/{botFilter,repoFilter}.ts` into it, behind a `GitHubWebhookAdapter` implementing `WebhookAdapter` (header names `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery` live here)
- [ ] 2.2 Make `GitHubWebhookAdapter` own `GITHUB_WEBHOOK_SECRET` loading/validation; remove `webhookSecret` from `ReceiverConfig`
- [ ] 2.3 Add `receiver/src/platform/index.ts` with `createWebhookAdapter(env)` using `parsePlatform`
- [ ] 2.4 Move the corresponding receiver tests (`verifySignature`, `triggerMap`, `botFilter`, `repoFilter`) next to the new code paths, keeping assertions unchanged

## 3. Receiver: request flow

- [ ] 3.1 Refactor `createApp` to take a `WebhookAdapter` and run the fixed check order through it (design D4), including the pre-enqueue `trigger.repo` allowlist re-check
- [ ] 3.2 Mount `POST /webhook/<adapter.name>` and the `POST /webhook` alias on the same handler; leave other `/webhook/*` paths unmounted (404)
- [ ] 3.3 Wire `server.ts` to build the adapter via the factory and pass it to `createApp`
- [ ] 3.4 Extend `webhook.integration.test.ts`: run the existing cases against both `/webhook/github` and `/webhook`; add `/webhook/gitlab` → 404; add the repo-mismatch → 204 case with a stub adapter; add receiver startup without `GITHUB_TOKEN`

## 4. Worker: GitHub repo provider and task tracker

- [ ] 4.1 Create `worker/src/platform/github/repoProvider.ts`: move clone (URL + `gitAuthEnv`), push, `gh label create` + `gh pr create` from `gitOps.ts`/`prCreate.ts`; `commitIdentity` returns the current name/noreply email
- [ ] 4.2 Create `worker/src/platform/github/taskTracker.ts`: move `gh issue comment` from `notify.ts`; add `closingReference` (`closes #N`) and `displayName` (`GitHub issue #N`)
- [ ] 4.3 Define GitHub `secretEnvNames` = `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_WEBHOOK_SECRET`; move `GITHUB_TOKEN` loading/validation into the GitHub worker platform and remove `githubToken` from `WorkerConfig`
- [ ] 4.4 Add `worker/src/platform/index.ts` with `createWorkerPlatform(env)` using `parsePlatform`
- [ ] 4.5 Keep platform-independent git operations (`createBranch`, `hasChanges`, add/commit, `branchName`, `kebab`) in `gitOps.ts`; split the old `createPr` into local commit + `platform.repo.push` + `platform.repo.openPullRequest`
- [ ] 4.6 Move `gitOps.test.ts` cases for clone/auth to the GitHub provider; keep local-git cases in place

## 5. Worker: task flow and secrets

- [ ] 5.1 Update `worker/src/main.ts` to create the platform once at startup and use `platform.repo` / `platform.tracker` for clone, push, PR, success comment and cost-abort comment
- [ ] 5.2 Build commit message and PR title from `tracker.closingReference`; update `readPipelineOutcome` in `pipeline.ts` to use `tracker.displayName` / `tracker.closingReference` for the PR body
- [ ] 5.3 Change `agentEnv` in `exec.ts` to take the withheld list as a parameter; pass `platform.secretEnvNames` from the pipeline invocation and every other agent-session call site
- [ ] 5.4 Pass `TASK_DISPLAY_NAME` to `pipeline.sh` and use it in the stage prompt header instead of the hardcoded `GitHub issue #${ISSUE_NUMBER}`
- [ ] 5.5 Update `secretIsolation.test.ts` to drive the withheld list from the GitHub platform; add a test that the pipeline env excludes all three names
- [ ] 5.6 Add tests: worker startup without `GITHUB_WEBHOOK_SECRET` succeeds; `PLATFORM=gitlab` fails fast; GitHub commit message/PR title/display name strings match the previous output

## 6. Docs and config

- [ ] 6.1 Add `PLATFORM` (default `github`, supported: `github`) to `.env.example`
- [ ] 6.2 Document `PLATFORM` and the `/webhook/github` route (with `/webhook` alias) in the README
- [ ] 6.3 Update `spec.md` (config table, receiver route, NG1 note describing the platform seam) and the CLAUDE.md architecture/config sections
- [ ] 6.4 Point `scripts/smoke-test.sh` at `/webhook/github` and add one request to the `/webhook` alias

## 7. Verification

- [ ] 7.1 `npm test` passes in `receiver/` and `worker/`; both `npx tsc` builds pass
- [ ] 7.2 `docker compose build && docker compose up`, then `bash scripts/smoke-test.sh` passes
- [ ] 7.3 End-to-end: label a real issue on a whitelisted repo; the PR title, commit message, PR body and issue comment match the pre-change format
- [ ] 7.4 `grep -rn "gh \|github.com\|GITHUB_" receiver/src worker/src` finds matches only under `*/src/platform/github/` and the platform factories
