# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim AS app-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /run/auto-agent-actions /var/lib/auto-agent-actions \
  && chown -R node:node /run/auto-agent-actions /var/lib/auto-agent-actions
USER node
CMD ["node", "dist/src/server.js"]

FROM app-runtime AS analysis-runtime
USER root
ARG CODEX_CLI_VERSION
RUN test -n "$CODEX_CLI_VERSION" \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/scripts/verify-codex-cli.mjs /tmp/verify-codex-cli.mjs
RUN node /tmp/verify-codex-cli.mjs "$CODEX_CLI_VERSION" \
  && rm /tmp/verify-codex-cli.mjs
RUN mkdir -p /var/lib/codex && chown node:node /var/lib/codex
ENV CODEX_HOME=/var/lib/codex
USER node
CMD ["node", "dist/src/analysis-worker.js"]
