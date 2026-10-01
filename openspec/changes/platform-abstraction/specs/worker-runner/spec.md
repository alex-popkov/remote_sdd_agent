## ADDED Requirements

### Requirement: Remote operations go through the platform

The worker SHALL perform clone, push and pull-request creation through the platform's `RepoProvider`, and SHALL post task comments (PR link, cost-abort notice) through the platform's `TaskTracker`. Local git operations (branch creation, change detection, staging, committing) SHALL remain platform-independent.

#### Scenario: PR and comment via the platform

- **WHEN** a pipeline run finishes with a non-empty diff
- **THEN** the worker opens the PR with `platform.repo.openPullRequest` and posts the PR link with `platform.tracker.comment`

### Requirement: Withheld secrets come from the platform

The worker SHALL withhold the platform's `secretEnvNames` from every agent session's environment. For the GitHub platform these SHALL be `GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_WEBHOOK_SECRET`.

#### Scenario: GitHub secrets absent from agent sessions

- **WHEN** the worker starts a pipeline with `PLATFORM=github` and `GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_WEBHOOK_SECRET` present in its own environment
- **THEN** none of the three variables is present in the environment of the `pipeline.sh` process or any `claude` session it starts
