# xChanger — Documentación Técnica

> Guía de onboarding para desarrolladores. Versión 1.0 · Agosto 2026.

---

## Tabla de contenidos

1. [Visión General y Filosofía](#1-visión-general-y-filosofía)
2. [Arquitectura Global y Stack](#2-arquitectura-global-y-stack)
3. [Estructura del Proyecto](#3-estructura-del-proyecto)
4. [Decisiones de Diseño Críticas](#4-decisiones-de-diseño-críticas)
   - 4.1 [Autenticación y Autorización (JWT en cookies HttpOnly)](#41-autenticación-y-autorización)
   - 4.2 [Modelo de Roles y AdminScope](#42-modelo-de-roles-y-adminscope)
   - 4.3 [Soft Delete](#43-soft-delete)
5. [Flujos de Tiempo Real (WebSockets)](#5-flujos-de-tiempo-real)
6. [Guía de Escalabilidad](#6-guía-de-escalabilidad)

---

## 1. Visión General y Filosofía

**xChanger** es una plataforma universitaria que coordina el **intercambio de grupos de prácticas** entre estudiantes de la Universidad de Cantabria. El problema que resuelve es puramente operativo: cuando un alumno quiere cambiar de grupo en una asignatura, hoy no existe un canal oficial para encontrar a otro alumno que quiera hacer el intercambio inverso. xChanger actúa como tablón de anuncios bidireccional con chat integrado y supervisión administrativa.

### Principios que guían el diseño

- **Mínimo privilegio**: cada acción del sistema está gateada por rol *y* por ámbito geográfico-académico (`AdminScope`). Ningún middleware confía en lo que dice el anterior.
- **Inmutabilidad de la auditoría**: los logs nunca se borran ni se modifican; son el único modelo del esquema sin `deletedAt`.
- **Tiempo real primero**: las notificaciones, los chats de ofertas y los chats de tickets usan WebSockets como canal principal; el email es un canal de respaldo fuera de banda.
- **Cero trust en el cliente**: los tokens de sesión viajan únicamente en cookies `HttpOnly`; JavaScript del navegador no puede leerlos.

---

## 2. Arquitectura Global y Stack

### Diagrama de alto nivel

```
┌─────────────────────────────────────────────────────────┐
│                        Cliente                          │
│           Astro (SSR + Islands de hidratación)          │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP (cookies HttpOnly) + WS
┌────────────────────▼────────────────────────────────────┐
│                      Backend                            │
│         Express (REST API) + Socket.io (WS)             │
│   Controlador → Servicio → Repositorio (Prisma)         │
└────────────────────┬────────────────────────────────────┘
                     │ SQL
┌────────────────────▼────────────────────────────────────┐
│             PostgreSQL 15  (+ PgBouncer en prod)        │
└─────────────────────────────────────────────────────────┘
```

### Stack

| Capa | Tecnología | Rol |
|---|---|---|
| Frontend | **Astro 4** | SSR por defecto; hidratación selectiva de componentes interactivos |
| Estilos | **Tailwind CSS** | Utilidades; clases `input-field`, `btn-primary` centralizadas en `global.css` |
| Backend | **Node.js 20 + Express 4** | API REST + servidor WS |
| Tiempo real | **Socket.io 4** | Chat de ofertas, chat de tickets, notificaciones push |
| ORM | **Prisma 5** | Esquema tipado, migraciones, soft delete por convención |
| Base de datos | **PostgreSQL 15** | Única fuente de verdad |
| Pool | **PgBouncer** | Modo transacción; deshabilitado en dev para evitar conflictos con prepared statements |
| Auth | **JWT** (jsonwebtoken) + **bcrypt** | Access/Refresh tokens en cookies; contraseñas con coste 10 |
| Email | **Nodemailer** | OTP de registro + notificaciones fuera de banda |
| Validación | **Zod** | Esquemas en controladores y en `config/env.ts` |
| Contenedores | **Docker Compose** | `db` (PostgreSQL) + `pgbouncer` (prod) |

### Por qué Monolito Modular y no microservicios

El ámbito actual (una universidad, pocos miles de usuarios) no justifica la sobrecarga operativa de microservicios. El patrón Controlador → Servicio → Repositorio impone la misma separación de responsabilidades que permitiría extraer un servicio en el futuro sin reescribir la lógica de negocio: el servicio no sabe nada de HTTP ni de SQL; el repositorio no sabe nada de reglas de negocio.

### Por qué Astro con SSR

Astro renderiza las páginas en servidor usando las cookies de sesión de la petición entrante. Eso significa que el HTML que llega al navegador ya está hidratado con los datos del usuario sin una segunda petición. Los componentes que requieren interactividad post-carga (formularios, dropdowns dinámicos) usan `<script>` client-side que llaman al backend mediante `api.ts`.

---

## 3. Estructura del Proyecto

```
xChangerMejorado/
├── docker-compose.yml          # Infraestructura local (PostgreSQL + PgBouncer)
├── doc.md                      # Este documento
├── requisitos.md               # Documento de requisitos funcionales
├── ssd.md                      # Documento de diseño de sistema
│
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # Fuente de verdad del modelo de datos
│   │   ├── seed.ts             # Inyección del usuario PROPIETARIO inicial
│   │   └── migrations/         # Historial de migraciones SQL (no editar a mano)
│   │
│   └── src/
│       ├── server.ts           # Punto de entrada; monta Express, Socket.io y middlewares globales
│       ├── config/
│       │   ├── env.ts          # Validación de variables de entorno con Zod (falla rápido al arranque)
│       │   └── prisma.ts       # Singleton de PrismaClient
│       ├── middleware/
│       │   ├── authenticate.ts # Verifica JWT y adjunta req.user
│       │   ├── authorize.ts    # requireRole() y requireScope() — ver §4.2
│       │   └── errorHandler.ts # Convierte AppError a respuesta JSON; log de errores inesperados
│       ├── controllers/        # Capa HTTP: parseo de request, validación Zod, llamada a servicio
│       ├── services/           # Lógica de negocio pura; no conoce Express ni Prisma directamente
│       ├── repositories/       # Acceso a datos: solo consultas Prisma; siempre filtran deletedAt: null
│       ├── routes/             # Montaje de rutas + aplicación de middlewares de auth
│       ├── sockets/
│       │   ├── socket.server.ts        # Handshake JWT, sala personal user:{id}
│       │   └── handlers/
│       │       ├── offer.handler.ts    # join_offer_room, send_offer_message
│       │       └── ticket.handler.ts   # join_ticket_room, send_ticket_message
│       └── utils/
│           ├── password.ts     # hashPassword, verifyPassword, validatePasswordComplexity
│           └── otp.ts          # generateOtpCode, hashOtpCode, signOtpToken, verifyOtpToken
│
└── frontend/
    └── src/
        ├── lib/
        │   ├── api.ts          # Wrapper fetch centralizado; credentials:'include'; lanza ApiError
        │   └── socket.ts       # Cliente Socket.io singleton con reconexión automática
        ├── layouts/
        │   ├── MainLayout.astro # Navbar + Footer presentes en todas las páginas autenticadas
        │   └── AuthLayout.astro # Layout limpio para login/registro
        ├── components/         # Componentes Astro reutilizables (Navbar, Footer, ChatWindow…)
        └── pages/              # Cada archivo .astro es una ruta; SSR por defecto
```

### Flujo de una petición típica (REST)

```
Navegador
  │  PATCH /api/auth/settings/password  (cookie access_token)
  ▼
authenticate.ts          ← verifica JWT, adjunta req.user
  ▼
auth.routes.ts           ← aplica authenticate; enruta al controlador
  ▼
auth.controller.ts       ← valida body con Zod; llama authService.changePassword()
  ▼
auth.service.ts          ← verifica contraseña actual, valida complejidad, hashea nueva
  ▼
user.repository.ts       ← prisma.user.update({ data: { passwordHash } })
  ▼
PostgreSQL
```

---

## 4. Decisiones de Diseño Críticas

### 4.1 Autenticación y Autorización

#### Flujo de registro (OTP de dos fases)

```
POST /api/auth/register
  └─ Valida email @alumnos.unican.es y complejidad de contraseña
  └─ Genera OTP de 6 dígitos (bcrypt hash) + JWT de 30 min (jti único)
  └─ Persiste PendingRegistration (no el User real)
  └─ Envía OTP por email
  └─ Devuelve JWT en cookie otp_token (HttpOnly, 30 min)

POST /api/auth/verify-otp
  └─ Lee otp_token de la cookie
  └─ Verifica firma JWT + jti contra PendingRegistration
  └─ Verifica OTP con bcrypt.compare
  └─ Crea User definitivo + elimina PendingRegistration
  └─ Emite Access Token (15 min) + Refresh Token (7 días) en cookies HttpOnly
```

`PendingRegistration` actúa como staging area: garantiza que un email no ocupa slot en `users` hasta que está verificado. Si el OTP expira, el registro simplemente desaparece.

#### Gestión de sesión (Access + Refresh Tokens)

| Token | TTL | Almacenamiento | Path de cookie |
|---|---|---|---|
| Access Token | 15 min | Cookie `access_token` HttpOnly | `/` |
| Refresh Token | 7 días | Cookie `refresh_token` HttpOnly | `/api/auth/refresh` |

El Refresh Token se guarda **hasheado con bcrypt** en `users.refresh_token_hash`. Esto permite revocación inmediata (logout, bloqueo) sin necesidad de una lista negra de tokens. Al renovar, el endpoint `/api/auth/refresh` verifica el hash; si no coincide, la sesión es inválida.

**Por qué cookies y no `localStorage`**: las cookies `HttpOnly` son inaccesibles desde JavaScript, lo que elimina el vector de ataque XSS más común contra tokens de sesión. `SameSite: strict` protege contra CSRF.

#### Cadena de middleware de autorización

Toda ruta protegida ejecuta en orden:

1. `authenticate` — Extrae el JWT de la cookie, verifica firma y expiración. Consulta la BD para confirmar que el usuario existe y no tiene `role === BLOQUEADO`. Adjunta `req.user` con `{ sub, email, role, jti }`.
2. `requireRole(...roles)` *(opcional)* — Comprueba que `req.user.role` está en la lista permitida.
3. `requireScope(options)` *(opcional, solo rutas de admin)* — Consulta `AdminScope` para verificar que el usuario tiene jurisdicción sobre la carrera/curso de la request.

Esta cadena es **iterativa e independiente**: cada middleware confía solo en `req.user` del anterior, nunca en datos del cuerpo de la petición para decisiones de seguridad.

#### Autenticación WebSocket

El handshake de Socket.io aplica el mismo control: extrae `access_token` de la cabecera `Cookie`, verifica el JWT y consulta la BD para descartar usuarios bloqueados. Si falla, la conexión se rechaza antes de que se registre ningún handler. Los eventos no tienen acceso a ningún dato de sesión sin pasar por este middleware.

---

### 4.2 Modelo de Roles y AdminScope

#### Los cuatro roles

| Rol | Descripción |
|---|---|
| `ESTUDIANTE` | Usuario base. Puede crear y aceptar ofertas, abrir tickets, editar su perfil. |
| `EMBAJADOR` | Hereda todas las acciones de ESTUDIANTE. Puede gestionar carreras/cursos **dentro de su ámbito**, ver y responder tickets de usuarios de su ámbito, bloquear usuarios de su ámbito. |
| `PROPIETARIO` | Ámbito total. Puede hacer todo lo que puede un EMBAJADOR, más: crear/eliminar carreras, promover/degradar embajadores, modificar ámbitos. Al crear una carrera, se le asigna automáticamente ámbito sobre ella. |
| `BLOQUEADO` | Sin acceso. La sesión activa expira en máximo 15 minutos (el Refresh Token es rechazado en la renovación). Las ofertas OPEN pasan a INACTIVE. |

#### La tabla `AdminScope`

`AdminScope` define el conjunto de pares `(carreraId, cursoId?)` sobre los que un usuario tiene poderes de administración:

```
AdminScope { userId, carreraId, cursoId? }

cursoId = null  → ámbito sobre TODA la carrera
cursoId = X     → ámbito reducido al curso X de esa carrera
```

Un embajador puede tener múltiples filas en `AdminScope`, lo que le da jurisdicción sobre varias carreras o varios cursos de distintas carreras simultáneamente.

#### Cómo el middleware evalúa el ámbito

```typescript
// requireScope({ carreraParam: 'carreraId' })
const scope = await prisma.adminScope.findFirst({
  where: {
    userId: user.sub,
    carreraId,
    OR: [
      { cursoId: null },   // cubre toda la carrera → implica el curso pedido
      { cursoId },          // cubre exactamente ese curso
    ],
  },
});
if (!scope) throw 403;
```

`PROPIETARIO` cortocircuita la consulta y siempre pasa. La consulta usa `OR` para que un ámbito de carrera completa cubra cualquier curso de ella sin necesidad de filas adicionales.

#### Invariante al crear una carrera

Cuando se crea una carrera nueva, `admin.service.ts` auto-asigna un `AdminScope` a **todos los usuarios con rol `PROPIETARIO`** activos en ese momento. Esto garantiza que los propietarios nunca pierdan visibilidad sobre recursos recién creados.

---

### 4.3 Soft Delete

#### Por qué no borrado físico

Eliminar físicamente un registro rompe la integridad referencial de la auditoría. Si un administrador elimina una carrera y luego se consultan los logs históricos, las acciones asociadas a esa carrera quedarían con claves foráneas huérfanas. Con Soft Delete:

- El dato **permanece** en la BD con `deleted_at = timestamp`.
- Los logs mantienen consistencia referencial.
- Los chats de ofertas cerradas y los mensajes de tickets siguen siendo legibles.
- La cascada de eliminación es **lógica** y controlable, no destructiva.

#### Convención en repositorios

**Todos** los repositorios filtran `deletedAt: null` en sus consultas. Esta es la convención más crítica del proyecto. Un error habitual al añadir una consulta nueva es olvidar este filtro:

```typescript
// ✅ Correcto
prisma.carrera.findMany({ where: { deletedAt: null } })

// ❌ Incorrecto — devuelve entidades eliminadas
prisma.carrera.findMany()
```

#### Modelos que NO tienen Soft Delete

- **`Log`**: inmutable por diseño. Nunca se borra, nunca se oculta.
- **`Message`**: inmutable por naturaleza conversacional. Un mensaje enviado no se retira.
- **`Notification`**: se marca como leída (`isRead`), no se elimina.
- **`PendingRegistration`**: se elimina físicamente al verificar el OTP (es temporal por diseño).
- **`AdminScope`**: se elimina físicamente al revocar un ámbito (no hay historial que preservar).

#### Cascada lógica al eliminar una carrera

```
deleteCarrera(carreraId)
  └─ Carrera.deletedAt = now()
       └─ Los repositorios filtran deletedAt: null → Cursos, Asignaturas y Grupos
          quedan "invisibles" sin tocar sus filas
       └─ Las Ofertas OPEN/ACCEPTED asociadas a asignaturas de esa carrera
          → se transicionan a CLOSED/INACTIVE
       └─ Se notifica (email + socket) a los usuarios afectados
```

Los registros hijos no se marcan individualmente; la exclusión es transitiva porque las consultas siempre suben por la jerarquía filtrando `deletedAt: null` en cada nivel.

---

## 5. Flujos de Tiempo Real

### Salas Socket.io

El servidor mantiene dos tipos de salas:

| Sala | Formato | Quién entra |
|---|---|---|
| Personal | `user:{userId}` | Cada usuario al conectarse (automático) |
| Chat de oferta | `offer:{offerId}` | Creador + aceptante de una oferta ACCEPTED |
| Chat de ticket | `ticket:{ticketId}` | Creador del ticket + cualquier EMBAJADOR/PROPIETARIO |

### Flujo: aceptar una oferta → chat activo

```
Cliente A llama POST /api/offers/:id/accept
  └─ offer.service.acceptOffer()
       └─ Valida que la oferta está OPEN y el aceptante no es el creador
       └─ offerRepo.updateStatus(id, ACCEPTED, acceptorId)
       └─ io.to('offer:{id}').emit('offer_accepted', {...})   ← si alguno ya estaba en la sala
       └─ notifyMany([creador, aceptante], ...)               ← notificación persistente + email

Ambos clientes navegan a /chat/offer/{id}
  └─ socket.emit('join_offer_room', { offerId })
       └─ Handler verifica: offer.status === ACCEPTED
          y (userId === offer.userId || userId === offer.acceptedById)
       └─ socket.join('offer:{offerId}')
       └─ socket.emit('joined_offer_room', { offerId, room })

Cliente A envía mensaje:
  socket.emit('send_offer_message', { offerId, content })
       └─ Handler re-verifica pertenencia y estado (no confía en el estado previo)
       └─ prisma.message.create(...)
       └─ io.to('offer:{offerId}').emit('new_offer_message', msg)
       └─ io.to('user:{counterpartId}').emit('receive_notification', {...})
```

### Flujo: ticket de soporte

```
Cliente abre ticket → POST /api/tickets
  └─ ticket.service crea Ticket con status=OPEN
  └─ Busca administrador con ámbito sobre la carrera del usuario
  └─ Asigna adminId y emite notificación al administrador

Ambos entran al chat:
  socket.emit('join_ticket_room', { ticketId })
       └─ Handler verifica: isOwner || isAdmin (EMBAJADOR o PROPIETARIO)

send_ticket_message delega en ticket.service.sendTicketMessage()
  — la lógica está en el servicio, no duplicada en el handler —
       └─ Verifica que el ticket está OPEN (un ticket CLOSED no acepta mensajes)
       └─ Verifica que el usuario no está BLOQUEADO
       └─ Persiste el mensaje
       └─ io.to('ticket:{id}').emit('new_ticket_message', msg)
       └─ Notifica al otro participante por su sala personal
```

### Canal de notificaciones globales

La sala `user:{userId}` recibe cualquier evento del sistema dirigido a ese usuario: nuevas ofertas que coinciden con su búsqueda, eliminación de asignaturas en las que está matriculado, respuestas a tickets. El frontend escucha `receive_notification` y actualiza el badge del navbar sin necesidad de polling.

---

## 6. Guía de Escalabilidad

Esta sección describe el proceso estándar para ampliar el sistema con nuevas funcionalidades. Seguir este orden minimiza el riesgo de introducir regresiones.

### 6.1 Añadir una nueva entidad al modelo de datos

**Ejemplo**: añadir un modelo `Recurso` (material de estudio vinculado a una `Asignatura`).

**Paso 1 — Actualizar `schema.prisma`**

```prisma
model Recurso {
  id           String    @id @default(cuid())
  titulo       String
  url          String
  asignaturaId String    @map("asignatura_id")
  autorId      String    @map("autor_id")
  deletedAt    DateTime? @map("deleted_at")   // ← obligatorio salvo excepciones del §4.3
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  asignatura Asignatura @relation(fields: [asignaturaId], references: [id])
  autor      User       @relation(fields: [autorId], references: [id])

  @@map("recursos")
}
```

**Paso 2 — Generar y aplicar la migración**

```bash
# Desde /backend
npx prisma migrate dev --name add_recurso
```

Esto genera el SQL en `prisma/migrations/` y regenera `@prisma/client` automáticamente.

**Paso 3 — Crear el repositorio** (`src/repositories/recurso.repository.ts`)

```typescript
export async function findByAsignatura(asignaturaId: string) {
  return prisma.recurso.findMany({
    where: { asignaturaId, deletedAt: null }, // ← siempre filtrar deletedAt
  });
}

export async function createRecurso(data: CreateRecursoInput) {
  return prisma.recurso.create({ data });
}
```

**Paso 4 — Crear el servicio** (`src/services/recurso.service.ts`)

El servicio contiene toda la lógica de negocio: validaciones de pertenencia, reglas de acceso, llamadas al log, notificaciones. No importa Express; no importa Prisma directamente.

**Paso 5 — Crear el controlador** (`src/controllers/recurso.controller.ts`)

Define los esquemas Zod, llama al servicio y formatea la respuesta HTTP. No contiene lógica de negocio.

**Paso 6 — Crear las rutas** (`src/routes/recurso.routes.ts`)

```typescript
const router = Router();
router.get('/', authenticate, recursoController.list);
router.post('/', authenticate, requireRole(Role.EMBAJADOR, Role.PROPIETARIO), recursoController.create);
export default router;
```

**Paso 7 — Montar las rutas en `server.ts`**

```typescript
import recursoRouter from './routes/recurso.routes';
app.use('/api/recursos', recursoRouter);
```

**Paso 8 — Frontend**

Añadir los tipos necesarios en `lib/api.ts` y construir la página/componente Astro que consuma el nuevo endpoint via `api.get('/recursos/...')`.

---

### 6.2 Añadir un nuevo rol o permiso

1. Añadir el valor al enum `Role` en `schema.prisma` y migrar.
2. Actualizar `requireRole()` en las rutas que deban incluirlo.
3. Revisar `requireScope()` si el nuevo rol tiene semántica de ámbito.
4. Actualizar `socket.server.ts` si el rol debe tener acceso distinto a las salas WS.
5. Actualizar la lógica de bloqueo en `authenticate.ts` si el rol tiene restricciones especiales de sesión.

---

### 6.3 Añadir un nuevo evento de tiempo real

1. Definir el evento en `src/sockets/handlers/` dentro del archivo de dominio correspondiente (o crear uno nuevo si el dominio es distinto).
2. Registrar el handler en `socket.server.ts` dentro del bloque `io.on('connection', ...)`.
3. **Siempre** re-verificar permisos dentro del handler (no asumir que el handshake es suficiente).
4. En el cliente, suscribirse en `src/lib/socket.ts` o directamente en el script de la página Astro.

---

### 6.4 Añadir una variable de entorno

1. Añadir el campo al esquema Zod en `src/config/env.ts`.
2. Añadir la variable a `.env.example` con un valor de ejemplo.
3. Documentar su propósito en el comentario inline del esquema.

El proceso de arranque valida todas las variables y **falla rápido** con un mensaje claro si alguna falta. No usar `process.env.VARIABLE` directamente fuera de `config/env.ts`.

---

### 6.5 Ejecutar el entorno de desarrollo desde cero

```bash
# 1. Levantar la base de datos
docker compose up -d

# 2. Instalar dependencias del backend
cd backend && npm install

# 3. Copiar y configurar variables de entorno
cp .env.example .env
# Editar .env con DATABASE_URL, DIRECT_URL, JWT secrets, SMTP...

# 4. Aplicar migraciones y generar el cliente Prisma
npx prisma migrate deploy
npx prisma generate

# 5. Sembrar el usuario administrador inicial
npm run db:seed

# 6. Arrancar el backend en modo desarrollo
npm run dev

# 7. En otra terminal, instalar dependencias del frontend
cd ../frontend && npm install
npm run dev
```

---

### 6.6 Despliegue en producción

El `docker-compose.yml` actual solo levanta la base de datos. Para producción completa:

1. **Backend**: construir imagen con `npm run build` → `node dist/server.js`. Asegurarse de que `DATABASE_URL` apunta al PgBouncer y `DIRECT_URL` apunta directamente a PostgreSQL (Prisma necesita una conexión directa para las migraciones).
2. **Frontend**: `npm run build` genera los artefactos SSR de Astro. Servirlos con Node.js (`node ./dist/server/entry.mjs`) o con el adaptador de servidor configurado en `astro.config.mjs`.
3. **Migraciones**: ejecutar `npx prisma migrate deploy` (nunca `migrate dev`) antes de arrancar el backend en cada despliegue.
4. **Seed**: ejecutar `npm run db:seed` solo una vez en el primer despliegue. El script usa `upsert` y es idempotente, pero no tiene sentido re-ejecutarlo en cada deploy.

---

*Este documento debe mantenerse actualizado cuando se añadan nuevas entidades, cambios de arquitectura o decisiones de diseño relevantes.*
