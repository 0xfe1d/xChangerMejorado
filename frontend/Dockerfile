# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# PUBLIC_API_URL se bake en el bundle del cliente por Astro/Vite (se pasa como ARG).
# API_URL (no-PUBLIC) se inlinea para el SSR; en runtime lo reemplaza la ENV del contenedor.
ARG PUBLIC_API_URL=http://9.160.161.200
ARG API_URL=http://backend:3000
ENV PUBLIC_API_URL=$PUBLIC_API_URL
ENV API_URL=$API_URL

RUN npm run build

# ── Stage 2: Runner ───────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# El adaptador standalone de Astro lee HOST y PORT de process.env en runtime
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["node", "./dist/server/entry.mjs"]
