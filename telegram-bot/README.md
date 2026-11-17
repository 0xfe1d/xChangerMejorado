# xChanger — Microservicio `telegram-bot`

Adaptador del canal Telegram para **xChanger**. Opera desacoplado del core: no accede a su base de datos ni replica reglas de negocio; toda la comunicación se realiza mediante `CoreClient` (REST `/api/v1`) y eventos en Redis (`xchanger:events`).

---

## Estructura actual

- [`src/contracts.ts`](src/contracts.ts): Contratos e interfaces compartidas entre la capa de infraestructura y la interfaz conversacional (`CoreClient`, `StateStore`, `CallbackStore`, `BotEventHandlers`, DTOs y `CoreApiError`).
- [`src/index.ts`](src/index.ts): Punto de entrada de servicios (`createBackServices()`), que provee `{ core, state, callbacks }`.
- [`src/mocks/mock-core.client.ts`](src/mocks/mock-core.client.ts): Implementación en memoria de `CoreClient` para desarrollo y pruebas locales sin dependencias externas.
- [`src/state/memory-stores.ts`](src/state/memory-stores.ts): Implementación en memoria de `StateStore` (estado conversacional, TTL de 15 min) y `CallbackStore` (claves cortas `< 64 bytes` para `callback_data`).
- [`src/config/env.ts`](src/config/env.ts): Validación de variables de entorno con Zod.

---

## Responsabilidades

### Capa de interfaz conversacional (Oscar)
- Configuración del cliente de Telegram (`grammy`, `telegraf`, etc.), registro de comandos, menús, teclados inline y manejo de flujo conversacional.
- Implementación de `BotEventHandlers` para el formateo y presentación de eventos entrantes.
- Consumo exclusivo de `{ core, state, callbacks }` a través de `createBackServices()` y las interfaces definidas en [`src/contracts.ts`](src/contracts.ts).
- Con `USE_MOCK_CORE=true` en `.env`, todos los flujos pueden probarse en local con datos en memoria.

### Capa de backend e integración (Samuel)
- Implementación de `CoreClient` contra `CORE_API_URL` (JWT de servicio, gestión y rotación de tokens de canal, `Idempotency-Key` y `X-Request-Id`).
- Persistencia de cuentas vinculadas y `refreshToken` cifrado con AES-256-GCM en `bot-db` (`telegram_accounts`).
- Implementación en Redis de `StateStore` y `CallbackStore`.
- Consumidor de Redis Streams (`xchanger:events`), cola de salida con control de *rate limit* y servidor HTTP (`POST /telegram/webhook`, `GET /healthz`).

---

## Catálogo de comandos y contratos

| Comando | Descripción | Métodos de `CoreClient` |
|---|---|---|
| `/start` | Bienvenida, aviso `RA-12` y menú inicial | `isLinked` |
| `/vincular` | Código y enlace de aprobación web | `createLinkRequest`, `exchangeLinkCode` |
| `/entrar` | Inicio de sesión por OTP de correo y MFA | `sendEmailOtp`, `verifyEmailOtp`, `verifyMfa` |
| `/registro` | Alta de cuenta sin contraseña | `listCareers`, `listCourses`, `registerFromTelegram`, `verifyRegistrationOtp` |
| `/perfil` | Consulta de perfil y estado MFA | `getProfile`, `getMfaStatus` |
| `/expediente` | Consulta, búsqueda, alta y baja de asignaturas | `getExpediente`, `searchSubjects`, `addToExpediente`, `removeFromExpediente` |
| `/buscar` | Búsqueda de ofertas complementarias y aceptación/publicación | `getExpediente`, `listSubjectGroups`, `searchOffers`, `acceptOffer`, `createOffer` |
| `/ofertar` | Publicación directa de oferta | `getExpediente`, `listSubjectGroups`, `createOffer` |
| `/misofertas` | Listado de ofertas propias/aceptadas y cierre | `listMyOffers`, `closeOffer` |
| `/chat` | Mensajería en ofertas `ACCEPTED` y comando `/salir` | `getOfferMessages`, `sendOfferMessage` |
| `/notificaciones` | Lectura, marcado y preferencias del canal | `getNotifications`, `markNotificationRead`, `getNotificationPreferences`, `updateNotificationPreferences` |
| `/desvincular` | Revocación de sesión o identidad vinculada | `revoke` |
