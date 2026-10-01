## Context

The agent is GitHub-only, and the GitHub code is spread across both containers:

| Area | GitHub-specific code today |
|---|---|
| receiver | `verifySignature.ts` (`X-Hub-Signature-256`), `app.ts` (`X-GitHub-Event`, `X-GitHub-Delivery` headers), `triggerMap.ts` (payload shape, `author_association`), `filters/botFilter.ts` (`[bot]` suffix), `filters/repoFilter.ts` (`repository.full_name`), `config.ts` (`GITHUB_WEBHOOK_SECRET`) |
| worker | `gitOps.ts` (`https://github.com/...` clone URL, `gitAuthEnv` extraheader, `@users.noreply.github.com` email), `prCreate.ts` (`git push`, `gh label create`, `gh pr create`), `notify.ts` (`gh issue comment`), `exec.ts` (hardcoded `AGENT_WITHHELD_ENV`), `config.ts` (`GITHUB_TOKEN`) |
| text | `"closes #N"` in the commit message and PR title, `"Closes #N."` / `"issue #N"` in the PR body (`pipeline.ts`), `"GitHub issue #N"` in the stage prompt header (`pipeline.sh`) |

Constraints that shape the design:
- The two containers build from different images. The receiver image has no `git`/`gh`; the worker image has no `express`. Both compile `shared/src/**` into their own build (`tsconfig.json` `include`).
- The receiver's non-negotiable security rules (CLAUDE.md, `spec.md` §4.1/§7) must hold for every current and future platform.
- Least privilege: today the receiver only needs the webhook secret and the worker only needs the API token. That must stay true.

## Goals / Non-Goals

**Goals:**
- One seam per platform: adding a platform later means adding one module per container side plus a factory entry, with no edits to the receiver's request flow or the worker's task flow.
- Zero behavior change for GitHub deployments; existing `.env` files and webhook URLs keep working.
- Security order is enforced by the core, not by each adapter.

**Non-Goals:**
- Implementing any platform other than GitHub (`spec.md` NG1).
- Different platforms for the repo host and the task tracker (e.g. Jira + GitHub). The repo host and tracker are always one platform per deployment.
- Several platforms in one deployment, or choosing the platform per task.
- Changing `TaskTrigger`, the queue file format, or the `triggerId` format.

## Decisions

### D1. One platform per deployment, selected by `PLATFORM` (default `github`)

Both containers read `PLATFORM` from the shared `.env`. A shared list `SUPPORTED_PLATFORMS = ['github']` lives in `shared/src/platform/`; an unknown value makes the container exit non-zero at startup with a message listing the supported values.

*Alternative considered:* recording the platform in each `TaskTrigger` so one deployment can serve several platforms. Rejected: it forces a queue-format migration and per-task credential routing for a capability nobody needs yet.

### D2. Three interfaces, split by the container that uses them

```ts
// shared/src/platform/types.ts
interface WebhookAdapter {                 // receiver
  readonly name: PlatformName;
  verifySignature(rawBody: Buffer, headers: IncomingHeaders): boolean;
  deliveryId(headers: IncomingHeaders): string | undefined;
  isBotSender(payload: unknown): boolean;
  repoOf(payload: unknown): RepoRef | undefined;   // checked against ALLOWED_REPOS
  toTrigger(headers: IncomingHeaders, payload: unknown, cfg: TriggerMapConfig): TaskTrigger | null;
}

interface RepoProvider {                   // worker
  clone(trigger: TaskTrigger, dest: string, baseBranch?: string): Promise<void>;
  commitIdentity(botMention: string): { name: string; email: string };
  push(repoDir: string, branch: string): Promise<void>;
  openPullRequest(o: { repoDir: string; trigger: TaskTrigger; head: string;
                       base?: string; title: string; body: string;
                       draft: boolean; labels: string[] }): Promise<string>; // PR URL
}

interface TaskTracker {                    // worker
  comment(trigger: TaskTrigger, body: string): Promise<void>;
  closingReference(trigger: TaskTrigger): string;   // GitHub: "closes #16"
  displayName(trigger: TaskTrigger): string;        // GitHub: "GitHub issue #16"
}

interface WorkerPlatform {
  repo: RepoProvider;
  tracker: TaskTracker;
  secretEnvNames: readonly string[];       // withheld from agent sessions
}
```

The trusted-author check for mentions stays inside `toTrigger`, because "trusted" is platform-specific (`author_association` on GitHub).

### D3. Two factories, one per container, keyed by the same `PLATFORM` value

- `receiver/src/platform/index.ts`: `createWebhookAdapter(env)` → `WebhookAdapter`. The GitHub implementation lives in `receiver/src/platform/github/` (moved from `verifySignature.ts`, `triggerMap.ts`, `filters/*`).
- `worker/src/platform/index.ts`: `createWorkerPlatform(env)` → `WorkerPlatform`. The GitHub implementation lives in `worker/src/platform/github/` (moved from the remote parts of `gitOps.ts`, `prCreate.ts`, `notify.ts`).
- Shared: interfaces, `PlatformName`, `SUPPORTED_PLATFORMS`, and `parsePlatform(env)` in `shared/src/platform/`.

Each factory reads and validates only the credentials its side needs: the receiver adapter needs `GITHUB_WEBHOOK_SECRET`, the worker platform needs `GITHUB_TOKEN`. Platform-specific credentials move out of the generic `ReceiverConfig`/`WorkerConfig` and into the platform implementations.

*Alternative considered:* one `createPlatform()` in `shared/` returning everything. Rejected: the receiver image would compile code that shells out to `git`/`gh`, and the receiver would have to require the API token it never uses.

### D4. The receiver keeps the security order; adapters only answer questions

`app.ts` stays the single place that sequences a request:

1. `adapter.verifySignature(rawBody, headers)` → 401 on failure, before anything else
2. `adapter.deliveryId(headers)` → dedupe store → 200 `duplicate`
3. `adapter.isBotSender(payload)` → 204
4. `adapter.repoOf(payload)` checked against `ALLOWED_REPOS` → 204 when missing or not allowed
5. `adapter.toTrigger(...)` → 204 when null
6. Defense in depth: the receiver re-checks that `trigger.repo` is in `ALLOWED_REPOS` before enqueueing, so an adapter whose `repoOf` and `toTrigger` disagree can't enqueue a non-allowlisted repo.
7. enqueue → 202

The raw-body capture (`express.json({ verify })`) and the timing-safe comparison stay as they are. A shared helper `timingSafeEqualStrings(a, b)` in `shared/src/platform/` lets every adapter use the same constant-time comparison.

### D5. Route `/webhook/<platform>` plus the `/webhook` alias

The receiver mounts only the configured platform's route, e.g. `POST /webhook/github`, plus `POST /webhook` handled the same way. Requests to another platform's route return 404. The alias keeps existing GitHub webhook URLs and `scripts/smoke-test.sh` working; removing it is out of scope.

### D6. The adapter must resolve a repo; how is up to the platform

Contract: a non-null `TaskTrigger` always carries `repo: { owner, name }`. GitHub reads it from `repository`. This matters for platforms where work items belong to a project with several repos (Azure DevOps): such an adapter would resolve the repo by its own convention or configuration, and the core never needs to know. `ALLOWED_REPOS` is applied to the resolved repo either way (D4).

### D7. Platform-specific text comes from the tracker

- Commit message and PR title: `` `agent: ${title} (${tracker.closingReference(t)})` `` / `` `${title} (${tracker.closingReference(t)})` ``. For GitHub this yields the same strings as today.
- PR body (`pipeline.ts` `readPipelineOutcome`): the lines currently using `issue #N` / `Closes #N.` use `tracker.displayName` / `tracker.closingReference`.
- Stage prompt header: the worker passes a new `TASK_DISPLAY_NAME` env var to `pipeline.sh`, which uses it in place of the hardcoded `"GitHub issue #${ISSUE_NUMBER}"`. The existing `ISSUE_*` env vars stay.

### D8. Withheld secrets come from the platform

`exec.ts` `agentEnv(env, withheld)` takes the list as a parameter. The worker passes `platform.secretEnvNames`, which for GitHub is `['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_WEBHOOK_SECRET']`, the same as today's hardcoded list. Including the webhook secret is deliberate: both containers load the same `.env`, so the worker process has it in its environment even though it doesn't use it.

## Risks / Trade-offs

- [Interfaces shaped only by GitHub may not fit the next platform] → Keep them minimal (only what GitHub uses today). Optional features (PR labels, draft PRs) are inputs a future provider may ignore rather than required capabilities.
- [Refactor regressions in a security-critical path] → Existing receiver tests (signature, allowlist, bot filter, mention trust, dedupe) move with the code and must pass unchanged in assertions; add a test that runs the same cases through `/webhook/github` and `/webhook`.
- [Withheld-env regression lets the agent read the token] → Keep `secretIsolation.test.ts`, now driven by the GitHub platform's `secretEnvNames`, and add a test that the worker passes those names into `agentEnv`.
- [Conflict with in-flight work] → The uncommitted secret-isolation changes in `worker/src/{exec,gitOps,prCreate,claudeCall,pipeline}.ts` touch the same files; commit them before starting this change.

## Migration Plan

1. Land the pending secret-isolation work.
2. Implement the change. No `.env` changes needed (`PLATFORM` defaults to `github`); the webhook URL `/webhook` keeps working.
3. Optionally update the GitHub webhook URL to `/webhook/github`.
4. Rollback: revert the change. Queue files and run directories are unaffected because `TaskTrigger` is unchanged.

Because `openspec/specs/` is still empty (`implement-remote-sdd-agent` isn't archived yet), this change's deltas for existing capabilities use ADDED requirements only. Archive `implement-remote-sdd-agent` before archiving this change.

## Open Questions

- Should `/webhook` (the alias) log a deprecation notice? Proposed: no, not for v1.
