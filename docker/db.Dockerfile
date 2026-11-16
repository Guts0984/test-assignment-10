FROM node:22-alpine AS build
RUN npm i -g pnpm@12.6.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @shop/db...
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN pnpm --filter @shop/shared build && pnpm --filter @shop/db build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/packages/db
CMD ["node", "dist/cli.js", "bootstrap"]
