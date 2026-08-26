# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Generar Prisma Client antes de compilar TypeScript
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Runner ───────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache dumb-init wget

WORKDIR /app
ENV NODE_ENV=production

# Copiar todo node_modules del builder (incluye prisma CLI para migrate deploy)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

EXPOSE 3000

# dumb-init gestiona señales SIGTERM/SIGINT correctamente
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
