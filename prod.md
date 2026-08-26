# xChanger — Guía de despliegue en producción

Máquina virtual: `9.160.161.200` | Puertos abiertos: `80` (HTTP), `443` (HTTPS), `3000` (backend directo)

---

## Arquitectura en producción

```
Navegador
    │
    ├─── :80  ──► Nginx ──► /api/*        ──► backend:3000 (Express)
    │                   ──► /socket.io/*  ──► backend:3000 (Socket.io WS)
    │                   ──► /*            ──► frontend:4321 (Astro SSR)
    │
    └─── :3000 ──► backend:3000 (acceso directo, útil para debug)

backend:3000 ──► db:5432 (PostgreSQL, solo red interna Docker)
```

---

## Requisitos previos en la VM

- Docker Engine ≥ 24
- Docker Compose plugin (`docker compose`) o Docker Compose v2

```bash
# Instalar en Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # reinicia sesión después
```

---

## Pasos para el primer despliegue

### 1. Subir el proyecto a la VM

```bash
# Opción A — git clone
git clone https://github.com/0xfe1d/xChangerMejorado.git
cd xChangerMejorado

# Opción B — rsync desde tu máquina local
rsync -avz --exclude node_modules --exclude dist \
  /ruta/local/xChangerMejorado/ \
  usuario@9.160.161.200:/home/usuario/xChangerMejorado/
```

### 2. Crear el fichero `.env` raíz (credenciales de PostgreSQL)

```bash
cp .env.example .env
nano .env          # rellena POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
```

Contenido mínimo requerido:

```env
POSTGRES_USER=xchanger_user
POSTGRES_PASSWORD=tu_contraseña_muy_segura
POSTGRES_DB=xchanger_db
```

> **Importante**: estos valores deben coincidir con los de tu `backend/.env`.

### 3. Verificar `backend/.env`

El `docker-compose.yml` sobreescribe automáticamente las variables de URL e
`NODE_ENV` del backend mediante el bloque `environment:`, por lo que **no es
necesario editar** `DATABASE_URL`, `DIRECT_URL`, `FRONTEND_URL`, `PORT` ni
`NODE_ENV` en `backend/.env`. Solo se leen de ese fichero:

```
JWT_ACCESS_SECRET    ← ya configurado
JWT_REFRESH_SECRET   ← ya configurado
JWT_ACCESS_EXPIRES_IN
JWT_REFRESH_EXPIRES_IN
JWT_OTP_EXPIRES_IN
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
SMTP_FROM
```

### 4. Levantar todo el sistema

```bash
docker compose up -d --build
```

Este comando:
1. Construye las imágenes de backend y frontend.
2. Levanta PostgreSQL y espera a que esté listo (`healthcheck`).
3. Ejecuta `prisma migrate deploy` (aplica las migraciones pendientes).
4. Arranca el backend Express + Socket.io en el puerto 3000.
5. Arranca el frontend Astro SSR en el puerto 4321 (interno).
6. Levanta Nginx en los puertos 80 y 443.

### 5. Verificar que todo funciona

```bash
# Estado de los contenedores
docker compose ps

# Logs en tiempo real
docker compose logs -f

# Health check del backend
curl http://9.160.161.200/api/health
# Respuesta esperada: {"status":"ok","timestamp":"..."}

# Frontend
curl -I http://9.160.161.200
# Respuesta esperada: HTTP/1.1 200 OK
```

---

## Comandos útiles en producción

```bash
# Ver logs de un servicio concreto
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f nginx

# Reiniciar un servicio sin rebuild
docker compose restart backend

# Actualizar el código y reconstruir
git pull
docker compose up -d --build

# Ejecutar seed (solo la primera vez si es necesario)
docker compose exec backend npx ts-node prisma/seed.ts

# Abrir una shell en el backend
docker compose exec backend sh

# Ver el estado de la base de datos con Prisma Studio
# (no recomendado en producción; usar solo para debug puntual)
docker compose exec backend npx prisma studio --port 5555

# Parar todo (los datos persisten en el volumen postgres_data)
docker compose down

# Parar todo y BORRAR los datos (¡destructivo!)
docker compose down -v
```

---

## HTTPS con Let's Encrypt (opcional)

Si dispones de un dominio apuntando a la VM:

```bash
# 1. Instalar Certbot
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot

# 2. Detener Nginx temporalmente para obtener el certificado
docker compose stop nginx

# 3. Obtener certificado
sudo certbot certonly --standalone -d tu-dominio.com

# 4. Copiar los certificados donde Nginx los pueda leer
sudo mkdir -p nginx/ssl
sudo cp /etc/letsencrypt/live/tu-dominio.com/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/tu-dominio.com/privkey.pem   nginx/ssl/

# 5. Descomentar el bloque HTTPS en nginx/nginx.conf,
#    añadir el volumen en docker-compose.yml:
#      - ./nginx/ssl:/etc/nginx/ssl:ro
#    y volver a levantar Nginx
docker compose up -d nginx
```

---

## Volver al entorno local (desarrollo)

Para ejecutar el proyecto en tu máquina local **sin Docker** (o con Docker pero
apuntando a localhost):

### Sin Docker

```bash
# Terminal 1 — PostgreSQL local (o usa el de Docker)
docker run -d --name pg_dev \
  -e POSTGRES_USER=xchanger_user \
  -e POSTGRES_PASSWORD=dev_password \
  -e POSTGRES_DB=xchanger_db \
  -p 5432:5432 postgres:15-alpine

# Terminal 2 — Backend
cd backend
# Restaurar backend/.env para desarrollo:
#   NODE_ENV=development
#   PORT=4000
#   DATABASE_URL=postgresql://xchanger_user:dev_password@localhost:5432/xchanger_db?sslmode=disable
#   DIRECT_URL=postgresql://xchanger_user:dev_password@localhost:5432/xchanger_db?sslmode=disable
#   FRONTEND_URL=http://localhost:3000
#   (JWT y SMTP sin cambios)
npx prisma migrate dev
npm run dev

# Terminal 3 — Frontend
cd frontend
# Restaurar/crear frontend/.env para desarrollo:
#   API_URL=http://localhost:4000
#   PUBLIC_API_URL=http://localhost:4000
npm run dev
```

### Con Docker Compose en local

Crea un fichero `docker-compose.override.yml` en la raíz (git lo ignora por defecto si lo añades al `.gitignore`):

```yaml
# docker-compose.override.yml — solo para desarrollo local
services:
  db:
    ports:
      - "5432:5432"   # exponer PostgreSQL al host

  backend:
    environment:
      NODE_ENV: development
      PORT: "4000"
      DATABASE_URL: "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}?sslmode=disable"
      DIRECT_URL:   "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}?sslmode=disable"
      FRONTEND_URL: "http://localhost:3000"
    ports:
      - "4000:3000"   # mapear al 4000 local

  frontend:
    build:
      args:
        PUBLIC_API_URL: "http://localhost:4000"
        API_URL: "http://backend:3000"
    environment:
      PORT: "3000"    # Astro en puerto 3000 localmente

  nginx:
    ports:
      - "8080:80"     # Nginx en 8080 para no requerir privilegios
```

Luego:
```bash
docker compose up -d --build
# Frontend disponible en http://localhost:8080
# Backend disponible en http://localhost:4000
```

---

## Resumen de ficheros creados/modificados para producción

| Fichero | Descripción |
|---|---|
| `docker-compose.yml` | Orquesta los 4 servicios (db, backend, frontend, nginx) |
| `backend/Dockerfile` | Build multi-stage: compila TS y genera Prisma Client |
| `frontend/Dockerfile` | Build multi-stage: bake de `PUBLIC_API_URL` + Astro SSR |
| `nginx/nginx.conf` | Reverse proxy: HTTP → frontend/backend + WebSocket |
| `.env.example` | Template de las variables PostgreSQL del compose |
| `backend/.dockerignore` | Excluye node_modules y dist del contexto de build |
| `frontend/.dockerignore` | Idem para el frontend |

---

## Variables de entorno por servicio (referencia rápida)

### Fichero `.env` (raíz — leído por docker-compose)
```
POSTGRES_USER       → usuario de PostgreSQL
POSTGRES_PASSWORD   → contraseña de PostgreSQL
POSTGRES_DB         → nombre de la base de datos
```

### `backend/.env` (leído por el contenedor backend vía env_file)
```
JWT_ACCESS_SECRET       → secreto del access token
JWT_REFRESH_SECRET      → secreto del refresh token
JWT_ACCESS_EXPIRES_IN   → duración del access token (ej: 15m)
JWT_REFRESH_EXPIRES_IN  → duración del refresh token (ej: 7d)
JWT_OTP_EXPIRES_IN      → duración del token OTP (ej: 30m)
SMTP_HOST               → servidor SMTP
SMTP_PORT               → puerto SMTP (ej: 587)
SMTP_SECURE             → true/false
SMTP_USER               → usuario SMTP
SMTP_PASS               → contraseña SMTP
SMTP_FROM               → dirección remitente
```

> Las variables `NODE_ENV`, `PORT`, `DATABASE_URL`, `DIRECT_URL` y `FRONTEND_URL`
> del backend son inyectadas directamente por el `docker-compose.yml` y sobreescriben
> cualquier valor que tengas en `backend/.env`.
