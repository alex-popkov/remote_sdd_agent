## ADDED Requirements

### Requirement: PLATFORM configuration variable

The system SHALL accept an optional `PLATFORM` environment variable, read by both the receiver and the worker, with default `github` and supported values `github`. Platform-specific credentials (`GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` for GitHub) SHALL be required only when that platform is selected. `.env.example`, the README and `spec.md` SHALL document `PLATFORM`, its supported values, and the `/webhook/<platform>` route.

#### Scenario: Existing .env works unchanged

- **WHEN** a deployment upgrades with an `.env` that has no `PLATFORM` variable
- **THEN** both containers start with the GitHub platform and behave as before

#### Scenario: Example file documents the variable

- **WHEN** a user reads `.env.example`
- **THEN** it lists `PLATFORM` with its default `github` and the supported values
