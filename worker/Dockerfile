# Build context is the repo root (configured in docker-compose).
FROM node:20-bookworm-slim

# Install git, gh CLI, and curl. gh's apt repo needs gnupg + a keyring setup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install the claude CLI globally — used by the worker pipeline (M5+).
RUN npm install -g @anthropic-ai/claude-code

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