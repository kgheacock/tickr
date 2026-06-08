FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/

RUN pnpm install --frozen-lockfile

COPY packages/shared-types/ packages/shared-types/
COPY apps/web/ apps/web/

RUN pnpm --filter @tickr/web run build

FROM scratch
COPY --from=build /app/apps/web/dist /srv/web
