FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma Client generation parses the datasource but never connects to it.
# This passwordless, build-only URL is scoped to this RUN layer.
RUN DATABASE_URL=postgresql://localhost/prisma-generate npx prisma generate
RUN npm run build --workspace=@nexus/api

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache python3
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/scripts ./scripts
RUN mkdir -p /app/uploads/imports /app/backups && chown -R node:node /app/uploads /app/backups
USER node
EXPOSE 3333
CMD ["node", "apps/api/dist/main.js"]
