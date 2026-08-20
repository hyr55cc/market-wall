# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile first so dependency layers cache across code changes.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we're about to copy.
RUN npm prune --omit=dev

# ---------- run ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Railway/Render inject PORT; this is the fallback for `docker run`.
ENV PORT=8080

# Run unprivileged. The image needs no write access to anything.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

# Container-level health check; the platform's own probe should hit /health too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
