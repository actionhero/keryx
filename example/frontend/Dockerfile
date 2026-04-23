FROM oven/bun:1 AS build
WORKDIR /app

# Install dependencies (cache layer)
COPY package.json bun.lock* ./
COPY packages/keryx/package.json packages/keryx/
COPY packages/plugins/observability/package.json packages/plugins/observability/
COPY packages/resque-admin/package.json packages/resque-admin/
COPY example/backend/package.json example/backend/
COPY example/frontend/package.json example/frontend/
COPY docs/package.json docs/
RUN bun install --frozen-lockfile

# Copy source needed for build (@backend alias requires backend types)
COPY packages/keryx/ packages/keryx/
COPY example/backend/ example/backend/
COPY example/frontend/ example/frontend/

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

WORKDIR /app/example/frontend
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/example/frontend/dist /usr/share/nginx/html
COPY example/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
