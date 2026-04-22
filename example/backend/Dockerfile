FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json bun.lock* ./
COPY packages/keryx/package.json packages/keryx/
COPY packages/resque-admin/package.json packages/resque-admin/
COPY example/backend/package.json example/backend/
COPY example/frontend/package.json example/frontend/
COPY docs/package.json docs/
RUN bun install --frozen-lockfile

# Copy source
COPY packages/keryx/ packages/keryx/
COPY example/backend/ example/backend/

WORKDIR /app/example/backend
RUN bun keryx.ts build
EXPOSE 8080
CMD ["bun", "keryx.ts", "start"]
