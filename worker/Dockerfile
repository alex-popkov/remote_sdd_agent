FROM node:20-bookworm-slim

# Install git, gh CLI, and curl for general use
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

# Install claude-code globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript --no-save && npx tsc

CMD ["node", "dist/poll.js"]
