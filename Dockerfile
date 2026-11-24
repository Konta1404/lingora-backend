# Lingora backend for Render (or any container host). Runs functions/src/server.ts.
FROM node:22-slim AS build
WORKDIR /app
COPY functions/package.json functions/package-lock.json ./
RUN npm ci
COPY functions/tsconfig.json ./
COPY functions/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY functions/package.json ./
COPY functions/data ./data
USER node
EXPOSE 8080
CMD ["node", "lib/src/server.js"]
