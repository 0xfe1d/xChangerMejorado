# Progreso del Backend — Microservicio `telegram-bot`

Rama de trabajo: `feat/telegram-bot-back`  
Referencia arquitectónica: [xchanger_escalado.pdf](../../docs/xchanger_escalado.pdf) (§6, §9, §11 y §12)  
Hoja de ruta: [BACK_ROADMAP.md](./BACK_ROADMAP.md)

---

## Estructura Base de Carpetas

Todo el código de infraestructura vive bajo `src/back/` para mantener una separación total respecto al Front conversacional (`src/front/`):

```text
telegram-bot/
├── package.json              # Un único servicio Node.js (un contenedor Docker)
├── tsconfig.json             # Validación TypeScript (src/ + test/, incluye tipos Jest)
├── tsconfig.build.json       # Compilación de producción (solo src/ -> dist/)
├── jest.config.js            # Configuración de tests unitarios con ts-jest
├── docs/
│   ├── BACK_ROADMAP.md       # Checklist de los 6 bloques y reglas de trabajo
│   └── BACK_PROGRESS.md      # Registro por bloques de lo implementado
├── test/                     # Pruebas unitarias por bloque
└── src/
    ├── contracts.ts          # Frontera compartida Back <-> Front
    ├── index.ts              # Punto de entrada (createBackServices)
    └── back/                 # Capa de backend e infraestructura
```

---

## Bloque 1 — Cifrado, `bot-db` y Almacenes en Redis (Completado)

### Qué se construyó

1. **Cifrado de `refreshToken` en reposo ([`token-cipher.ts`](../src/back/crypto/token-cipher.ts))**
   - Clase [`TokenCipher`](../src/back/crypto/token-cipher.ts#L43) con **AES-256-GCM**.
   - Acepta `TOKEN_ENC_KEY` de 32 bytes (en `base64` o `hex`), genera IV aleatorio de 12 bytes y usa `tg:<telegramUserId>` como **AAD**.
   - Formato almacenado: `v1:<iv_base64url>:<tag_base64url>:<ciphertext_base64url>`.

2. **Base de datos propia del bot — `bot-db` ([`db.ts`](../src/back/config/db.ts), [`accounts.repo.ts`](../src/back/storage/accounts.repo.ts))**
   - Pool PostgreSQL con `pg` ([`getBotDb`](../src/back/config/db.ts#L32), [`closeBotDb`](../src/back/config/db.ts#L54)) e inicialización idempotente ([`initBotDatabase`](../src/back/config/db.ts#L49)) de la tabla `telegram_accounts` y sus índices (`core_user_id`, `channel_session_id`).
   - [`TelegramAccountsRepository`](../src/back/storage/accounts.repo.ts#L57): consultas SQL parametrizadas y cifrado/descifrado automático del `refreshToken`:
     - [`upsertAccount`](../src/back/storage/accounts.repo.ts#L63) / [`findByTelegramUserId`](../src/back/storage/accounts.repo.ts#L96)
     - [`findByCoreUserId`](../src/back/storage/accounts.repo.ts#L112) / [`findByCoreUserIds`](../src/back/storage/accounts.repo.ts#L125)
     - [`updateRotatedSession`](../src/back/storage/accounts.repo.ts#L138)
     - [`deleteByTelegramUserId`](../src/back/storage/accounts.repo.ts#L154) / [`deleteByCoreUserId`](../src/back/storage/accounts.repo.ts#L162) / [`deleteBySessionId`](../src/back/storage/accounts.repo.ts#L170)

3. **Conexión y almacenes en Redis bajo prefijo `tg:*` ([`redis.ts`](../src/back/config/redis.ts), [`redis-stores.ts`](../src/back/storage/redis-stores.ts))**
   - Cliente compartido [`getRedis`](../src/back/config/redis.ts#L7), fábrica [`createRedisConnection`](../src/back/config/redis.ts#L18) y [`closeRedis`](../src/back/config/redis.ts#L29).
   - [`RedisStateStore`](../src/back/storage/redis-stores.ts#L48) (`tg:state:<chatId>`, TTL 15 min): [`get`](../src/back/storage/redis-stores.ts#L55), [`set`](../src/back/storage/redis-stores.ts#L60), [`clear`](../src/back/storage/redis-stores.ts#L68).
   - [`RedisCallbackStore`](../src/back/storage/redis-stores.ts#L77) (`cb:<16_hex>` `< 64` bytes en `tg:cb:*`, TTL 24 h): [`encode`](../src/back/storage/redis-stores.ts#L84), [`decode`](../src/back/storage/redis-stores.ts#L90).
   - [`RedisPendingLinkStore`](../src/back/storage/redis-stores.ts#L103) (`tg:link:<externalUserId>`, TTL 10 min): [`save`](../src/back/storage/redis-stores.ts#L110), [`get`](../src/back/storage/redis-stores.ts#L118), [`consume`](../src/back/storage/redis-stores.ts#L127).
   - [`RedisDedupStore`](../src/back/storage/redis-stores.ts#L138) (`tg:upd:*` y `tg:evt:done:*`, TTL 24 h): [`markTelegramUpdateOnce`](../src/back/storage/redis-stores.ts#L145), [`isEventProcessed`](../src/back/storage/redis-stores.ts#L153), [`markEventProcessed`](../src/back/storage/redis-stores.ts#L157).

### Archivos del Bloque 1

| Archivo | Qué hace |
| :--- | :--- |
| [`env.ts`](../src/back/config/env.ts) | Valida con Zod todas las variables de `.env` al arrancar (exige secretos si `USE_MOCK_CORE=false`). |
| [`db.ts`](../src/back/config/db.ts) | Abre el pool de PostgreSQL (`bot-db`) y crea automáticamente `telegram_accounts` e índices. |
| [`redis.ts`](../src/back/config/redis.ts) | Crea y cierra las conexiones `ioredis` hacia Redis. |
| [`token-cipher.ts`](../src/back/crypto/token-cipher.ts) | Cifra y descifra los `refreshToken` con `AES-256-GCM` + AAD ligado al `telegramUserId`. |
| [`accounts.repo.ts`](../src/back/storage/accounts.repo.ts) | Consultas SQL parametrizadas a `telegram_accounts`. |
| [`redis-stores.ts`](../src/back/storage/redis-stores.ts) | Implementa en Redis bajo prefijo `tg:*` estado, callbacks, links pendientes y dedup. |
| [`contracts.ts`](../src/contracts.ts) | Interfaces compartidas entre Back y Front (`CoreClient`, `StateStore`, `CallbackStore`, `BotEventHandlers`). |
| [`index.ts`](../src/index.ts) | Punto de entrada ([`createBackServices`](../src/index.ts#L18)) que entrega `{ core, state, callbacks }`. |
| [`block1.spec.ts`](../test/block1.spec.ts) | 9 pruebas unitarias de Jest (cifrado, almacenes Redis y repositorio `bot-db`). |
| [`tsconfig.json`](../tsconfig.json) / [`tsconfig.build.json`](../tsconfig.build.json) | `tsconfig.json` valida `src/` + `test/`; `tsconfig.build.json` compila solo `src/` a `dist/`. |
| [`jest.config.js`](../jest.config.js) | Configura Jest con `ts-jest` para ejecutar `test/*.spec.ts`. |

### Verificación del Bloque 1

```bash
npm run typecheck   # 0 errores
npm test            # test/block1.spec.ts -> 9/9 tests pasados
npm run build       # dist/index.js generado
```

---

## Bloque 2 — Autenticación de Servicio y Sesiones de Canal (Completado)

### Qué se construyó

1. **Autenticación de Servicio `S` ([`service-auth.ts`](../src/back/core/service-auth.ts))**
   - [`parseCoreError`](../src/back/core/service-auth.ts#L17): normaliza cualquier respuesta HTTP de error del Core en [`CoreApiError`](../src/contracts.ts#L14) (`error`, `code`, `details`, `requestId`).
   - [`ServiceAuthManager`](../src/back/core/service-auth.ts#L63): obtiene el JWT de servicio vía `POST /api/v1/service-auth/token` (`EP-C-01`), lo cachea en memoria, renueva automáticamente cuando le quedan `< 60 s` ([`getToken`](../src/back/core/service-auth.ts#L82)) agrupando llamadas concurrentes (`inFlight`), y permite forzar renovación con [`invalidate`](../src/back/core/service-auth.ts#L96).

2. **Gestor de Sesiones de Canal `U` ([`session-manager.ts`](../src/back/core/session-manager.ts))**
   - [`ChannelSessionManager`](../src/back/core/session-manager.ts#L57):
     - [`isLinked`](../src/back/core/session-manager.ts#L98): comprueba si el usuario tiene sesión vinculada en Redis o `bot-db`.
     - [`saveIssuedSession`](../src/back/core/session-manager.ts#L107): guarda el `refreshToken` cifrado en `bot-db` y cachea el `accessToken` en `tg:sess:access:<externalUserId>` con margen de seguridad de 30 s.
     - [`getValidAccessToken`](../src/back/core/session-manager.ts#L133): devuelve el `accessToken` de Redis o dispara la rotación automática.
     - [`refreshSession`](../src/back/core/session-manager.ts#L142): rota el `refreshToken` contra `EP-C-06` (`grant_type: "refresh_token"`) serializando en memoria (`inFlightByUser`) y mediante lock distribuido en Redis (`tg:lock:refresh:*`) para evitar `REUSE_DETECTED`. Limpia la sesión local ante errores fatales (`INVALID_GRANT`, `EXPIRED_TOKEN`, `SESSION_REVOKED`, `ACCOUNT_BLOCKED`).
     - [`clearLocalSession`](../src/back/core/session-manager.ts#L246) / [`clearBySessionId`](../src/back/core/session-manager.ts#L252) / [`clearByCoreUserId`](../src/back/core/session-manager.ts#L260): limpian `bot-db` y Redis tras `/desvincular`, revocaciones o bloqueos.

### Archivos del Bloque 2

| Archivo | Qué hace |
| :--- | :--- |
| [`service-auth.ts`](../src/back/core/service-auth.ts) | Gestiona y auto-renueva el JWT de servicio (`EP-C-01`) y normaliza errores del Core a `CoreApiError`. |
| [`session-manager.ts`](../src/back/core/session-manager.ts) | Gestiona `accessToken` en Redis y rotación segura de `refreshToken` en `bot-db` con lock distribuido (`EP-C-06`). |
| [`block2.spec.ts`](../test/block2.spec.ts) | 7 pruebas unitarias de Jest que validan `ServiceAuthManager` y `ChannelSessionManager`. |

### Verificación del Bloque 2

```bash
npm run typecheck   # 0 errores
npm test            # 2 suites (block1 + block2) -> 16/16 tests pasados
npm run build       # dist/index.js generado
```

---

## Bloque 3 — `HttpCoreClient` (REST `/api/v1` + Caché) (Completado)

### Qué se construyó

1. **Caché de catálogo y grupos en Redis ([`catalog-cache.ts`](../src/back/core/catalog-cache.ts))**
   - [`RedisCatalogCache`](../src/back/core/catalog-cache.ts#L28) (claves `tg:cache:catalog:*`, TTL de 5 min): cachea carreras ([`getCareers`](../src/back/core/catalog-cache.ts#L51) / [`setCareers`](../src/back/core/catalog-cache.ts#L55)), cursos ([`getCourses`](../src/back/core/catalog-cache.ts#L59) / [`setCourses`](../src/back/core/catalog-cache.ts#L64)) y grupos ([`getGroups`](../src/back/core/catalog-cache.ts#L69) / [`setGroups`](../src/back/core/catalog-cache.ts#L74)).
   - [`invalidateByAcademicEvent`](../src/back/core/catalog-cache.ts#L82): invalidación en O(1) mediante claves versionadas (`tg:cache:catalog:ver:courses` y `tg:cache:catalog:ver:groups`) sin usar `KEYS` ni `SCAN`, compatible con Redis ACL restringido a `tg:*`.

2. **Refresco seguro ante token expirado ([`session-manager.ts`](../src/back/core/session-manager.ts))**
   - [`refreshOnExpired`](../src/back/core/session-manager.ts#L167): evita reutilizar de Redis el mismo `accessToken` recién rechazado con `401 TOKEN_EXPIRED` y coordina el refresco único en memoria y entre réplicas.

3. **Transporte HTTP hacia el Core ([`core-http.ts`](../src/back/core/core-http.ts))**
   - [`CoreHttpTransport`](../src/back/core/core-http.ts#L60) ([`send`](../src/back/core/core-http.ts#L92) + [`execute`](../src/back/core/core-http.ts#L170)): centraliza `X-Service-Authorization`, `Authorization`, `X-Request-Id` (ULID constante en reintentos), `Accept-Language: es`, `Idempotency-Key` (`tg:<updateId>` o UUID v4), timeouts con `AbortController`, reintento único ante `401 TOKEN_EXPIRED` / `401 SERVICE_UNAUTHORIZED` y limpieza local ante `401 SESSION_REVOKED` o `403 ACCOUNT_BLOCKED`.

4. **Cliente HTTP del Core ([`http-core.client.ts`](../src/back/core/http-core.client.ts))**
   - [`HttpCoreClient`](../src/back/core/http-core.client.ts#L75) implementa los **31 métodos** de [`CoreClient`](../src/contracts.ts#L239) delegando la red en `CoreHttpTransport`:
     - Adaptadores al backend actual: [`adaptLegacySubjects`](../src/back/core/http-core.client.ts#L50), mapeo `mfaRequired` en [`verifyEmailOtp`](../src/back/core/http-core.client.ts#L133), limpieza idempotente en [`revoke`](../src/back/core/http-core.client.ts#L206), `status === 201` en [`addToExpediente`](../src/back/core/http-core.client.ts#L279), cabecera `X-Next-Cursor` en [`getNotifications`](../src/back/core/http-core.client.ts#L430) y envoltorio `{ telegram }` en [`updateNotificationPreferences`](../src/back/core/http-core.client.ts#L474).
     - Nota de backend: [`getOfferMessages`](../src/back/core/http-core.client.ts#L397) apunta a `GET /offers/:id/messages` (`EP-C-15`, pendiente de añadir en `backend/` para Fase F3).

### Archivos del Bloque 3

| Archivo | Qué hace |
| :--- | :--- |
| [`catalog-cache.ts`](../src/back/core/catalog-cache.ts) | Caché Redis TTL 5 min para carreras, cursos y grupos con invalidación O(1) por eventos `academic.changed`. |
| [`session-manager.ts`](../src/back/core/session-manager.ts) | Amplía `ChannelSessionManager` con `refreshOnExpired` para evitar reutilizar tokens recién caducados tras `401`. |
| [`core-http.ts`](../src/back/core/core-http.ts) | Motor HTTP (`CoreHttpTransport`) con cabeceras, idempotencia, timeouts y reintentos únicos ante `401`. |
| [`http-core.client.ts`](../src/back/core/http-core.client.ts) | Implementa los 31 métodos REST `/api/v1` de `CoreClient` sobre `CoreHttpTransport` y `RedisCatalogCache`. |
| [`block3.spec.ts`](../test/block3.spec.ts) | 6 pruebas unitarias de Jest (flujos `S`, reintentos `401`, concurrencia, caché e invalidación, adaptadores y errores). |

### Verificación del Bloque 3

```bash
npm run typecheck   # 0 errores
npm test            # 3 suites (block1 + block2 + block3) -> 22/22 tests pasados
npm run build       # dist/index.js generado
```

---

## Bloque 4 — Consumidor de Eventos (`xchanger:events`) (Completado)

### Qué se construyó

1. **Contador de reintentos por evento bajo prefijo `tg:*` ([`redis-stores.ts`](../src/back/storage/redis-stores.ts))**
   - En `RedisDedupStore` se añadieron [`incrementEventTries`](../src/back/storage/redis-stores.ts#L164) (`tg:evt:tries:<eventId>`, TTL 24 h) y [`clearEventTries`](../src/back/storage/redis-stores.ts#L175) usando únicamente comandos permitidos por la ACL de Redis (`tg:*`).

2. **Despachador de eventos del dominio ([`event-dispatcher.ts`](../src/back/events/event-dispatcher.ts))**
   - [`BotEventDispatcher`](../src/back/events/event-dispatcher.ts#L53) ([`dispatch`](../src/back/events/event-dispatcher.ts#L56)):
     - [`handleAcademicChanged`](../src/back/events/event-dispatcher.ts#L91): invalida `RedisCatalogCache` ante cambios en `CARRERA`, `CURSO`, `ASIGNATURA` o `GRUPO`.
     - [`handleChannelLinkApproved`](../src/back/events/event-dispatcher.ts#L97) / [`handleChannelLinkDenied`](../src/back/events/event-dispatcher.ts#L129): canjea automáticamente el `deviceCode` guardado en `RedisPendingLinkStore` llamando a `exchangeLinkCode` (tolerando `INVALID_GRANT` si el sondeo ganó la carrera) y notifica al chat.
     - [`handleSessionRevoked`](../src/back/events/event-dispatcher.ts#L137) / [`handleAccountBlocked`](../src/back/events/event-dispatcher.ts#L148): borran la sesión en Redis y `bot-db`, y evitan doble aviso cuando llega `channel.session.revoked` con `reason === 'BLOCKED'`.
     - [`dispatchAudienceEvent`](../src/back/events/event-dispatcher.ts#L155): filtra `event.audience` en lote contra `telegram_accounts` (`bot-db`), descarta en silencio eventos ajenos (§11 Privacidad), respeta `delivery.telegram` / `delivery.telegramChatMessages` en `notification.created` y entrega `offer.message.created`, `offer.status.changed` y `account.unblocked` a [`BotEventHandlers`](../src/contracts.ts#L486).

3. **Consumidor de Redis Streams ([`event-consumer.ts`](../src/back/events/event-consumer.ts))**
   - [`RedisEventStreamConsumer`](../src/back/events/event-consumer.ts#L72) sobre `xchanger:events` (grupo `telegram-bot`):
     - [`ensureGroup`](../src/back/events/event-consumer.ts#L104): `XGROUP CREATE ... $ MKSTREAM` tolerando `BUSYGROUP`.
     - [`processAvailable`](../src/back/events/event-consumer.ts#L156), [`reclaimStale`](../src/back/events/event-consumer.ts#L180) y [`start`](../src/back/events/event-consumer.ts#L199): lectura con `XREADGROUP`, recuperación de pendientes con `XAUTOCLAIM`, deduplicación por `event.id` (`tg:evt:done:*`), límite de `MAX_EVENT_DELIVERIES = 5` intentos con `XACK` y métrica [`getConsumerLagMs`](../src/back/events/event-consumer.ts#L100) para `/healthz`.

### Archivos del Bloque 4

| Archivo | Qué hace |
| :--- | :--- |
| [`redis-stores.ts`](../src/back/storage/redis-stores.ts) | Amplía `RedisDedupStore` con `tg:evt:tries:*` para contar reintentos sin salir de la ACL `tg:*`. |
| [`event-dispatcher.ts`](../src/back/events/event-dispatcher.ts) | Aplica reacciones de infraestructura, filtra por `audience` contra `bot-db` y dispara `BotEventHandlers`. |
| [`event-consumer.ts`](../src/back/events/event-consumer.ts) | Consume `xchanger:events` en el grupo `telegram-bot` con `XREADGROUP`, `XAUTOCLAIM`, `XACK` y dedup por `event.id`. |
| [`block4.spec.ts`](../test/block4.spec.ts) | 6 pruebas unitarias de Jest (stream consumer, `XAUTOCLAIM`, privacidad `audience`, link aprobado, bloqueo/revocación, caché y chat). |

### Verificación del Bloque 4

```bash
npm run typecheck   # 0 errores
npm test            # 4 suites (block1 + block2 + block3 + block4) -> 28/28 tests pasados
npm run build       # dist/index.js generado
```
