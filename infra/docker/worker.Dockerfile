FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @campus/worker... build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system campus && useradd --system --gid campus campus
COPY --from=build --chown=campus:campus /app /app
USER campus
CMD ["node", "apps/worker/dist/main.js"]

