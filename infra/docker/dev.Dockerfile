FROM node:22-alpine

# Dev image: monorepo + pnpm + Docker CLI (for sandbox-runner local runs).
RUN corepack enable 2>/dev/null || npm i -g pnpm@latest
RUN apk add --no-cache docker-cli curl

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile

# Default: run the full test suite + typecheck.
CMD ["pnpm", "run", "test"]
