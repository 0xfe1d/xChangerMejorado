# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# openssl requerido por el schema engine de Prisma durante generate
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Runner ───────────────────────────────────────────
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init wget openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Copiar todo node_modules del builder (incluye prisma CLI para migrate deploy)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

EXPOSE 3000

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

# dumb-init gestiona señales SIGTERM/SIGINT correctamente
ENTRYPOINT ["dumb-init", "--"]
CMD ["/bin/sh", "entrypoint.sh"]
