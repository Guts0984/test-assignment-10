FROM node:22-alpine AS build
RUN npm i -g pnpm@12.6.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @shop/api...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @shop/shared build && pnpm --filter @shop/db build && pnpm --filter @shop/api build
# production-only node_modules for the api (no dev tooling in the final image)
RUN pnpm --filter @shop/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
COPY docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh
USER node
EXPOSE 4000
ENTRYPOINT ["api-entrypoint.sh"]
CMD ["node", "dist/main.js"]
