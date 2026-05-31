# Build context is the repo root (configured in docker-compose).
# git is pinned implicitly by the base-image tag (node:20-bookworm-slim ships
# Debian bookworm's git). Bump the tag to move git.
FROM node:20-bookworm-slim

# Pinned tool versions. Bump deliberately in a dedicated PR (design.md risk:
# "gh and git CLI version drift" / "Claude CLI behavior changes").
ARG GH_VERSION=2.93.0
ARG CLAUDE_CODE_VERSION=2.1.158

# Install git + curl from apt, then gh from a pinned upstream .deb so the
# version is locked rather than tracking the rolling apt repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /tmp/gh.deb \
       "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && git --version && gh --version

# Install the claude CLI globally (pinned) — used by the naive call (M4) and
# the SDD pipeline (M5+).
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version

WORKDIR /app

# Bring in shared types alongside the worker source.
COPY shared/ ./shared/

COPY worker/package.json worker/package-lock.json* ./worker/
WORKDIR /app/worker
RUN npm install --omit=dev

COPY worker/tsconfig.json ./
COPY worker/src ./src
RUN npm install typescript --no-save && npx tsc

WORKDIR /app

# tsc with include ["src/**/*", "../shared/src/**/*"] places output at
# dist/worker/src/main.js (rootDir is auto-inferred to /app).
CMD ["node", "worker/dist/worker/src/main.js"]