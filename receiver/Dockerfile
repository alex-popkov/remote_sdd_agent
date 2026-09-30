# Build context is the repo root (configured in docker-compose). This lets the
# image pull in shared/ alongside receiver/ so TypeScript can resolve the
# cross-package import without a publish step.

FROM node:20-alpine

WORKDIR /app

# Bring in the shared types package first so its files exist before tsc runs.
COPY shared/ ./shared/

# Install deps before copying source so npm-install is cached separately.
COPY receiver/package.json receiver/package-lock.json* ./receiver/
WORKDIR /app/receiver
# better-sqlite3 (delivery dedupe) is a native module: it normally pulls a
# prebuilt musl binary, but keep a toolchain around for the source-build
# fallback, then drop it to keep the image small.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && apk del .build-deps

COPY receiver/tsconfig.json ./
COPY receiver/src ./src

# typescript is a dev dep, install transiently for the build.
RUN npm install typescript --no-save && npx tsc

WORKDIR /app
RUN chown -R node:node /app
USER node

EXPOSE 3000
# tsc with include ["src/**/*", "../shared/src/**/*"] places output at
# dist/receiver/src/server.js (rootDir is auto-inferred to /app).
CMD ["node", "receiver/dist/receiver/src/server.js"]