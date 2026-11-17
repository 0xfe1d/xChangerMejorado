# Progreso del Backend — Microservicio `telegram-bot`

Rama de trabajo: `feat/telegram-bot-back`  
Referencia arquitectónica: [xchanger_escalado.pdf](../../docs/xchanger_escalado.pdf) (§6, §9, §11 y §12)  
Hoja de ruta: [BACK_ROADMAP.md](./BACK_ROADMAP.md)

---

## Estructura de Carpetas

Todo el código de infraestructura vive bajo `src/back/` para mantener una separación total respecto al Front conversacional (`src/front/`):

```text
telegram-bot/
├── package.json              # Un único servicio Node.js (un contenedor Docker)
├── tsconfig.json             # Validación TypeScript (src/ + test/, incluye tipos Jest)
├── tsconfig.build.json       # Compilación de producción (solo src/ -> dist/)
├── jest.config.js            # Configuración de tests unitarios con ts-jest
├── docs/BACK_PROGRESS.md     # Este registro de progreso por bloques
├── test/                     # Pruebas unitarias
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
   - Acepta `TOKEN_ENC_KEY` de 32 bytes (en `base64` o `hex`).
   - Genera un IV aleatorio de 12 bytes en cada cifrado y usa `tg:<telegramUserId>` como **AAD** (*Additional Authenticated Data*), impidiendo que un registro cifrado pueda reutilizarse bajo otro usuario.
   - Formato almacenado: `v1:<iv_base64url>:<tag_base64url>:<ciphertext_base64url>`.

2. **Base de datos propia del bot — `bot-db` ([`db.ts`](../src/back/config/db.ts), [`accounts.repo.ts`](../src/back/storage/accounts.repo.ts))**
   - Pool PostgreSQL con `pg` ([`getBotDb`](../src/back/config/db.ts#L32), [`closeBotDb`](../src/back/config/db.ts#L54)) e inicialización idempotente ([`initBotDatabase`](../src/back/config/db.ts#L49)) que crea la tabla `telegram_accounts` y sus índices (`core_user_id`, `channel_session_id`).
   - [`TelegramAccountsRepository`](../src/back/storage/accounts.repo.ts#L57): consultas SQL parametrizadas y cifrado/descifrado automático del `refreshToken`:
     - [`upsertAccount`](../src/back/storage/accounts.repo.ts#L63) / [`findByTelegramUserId`](../src/back/storage/accounts.repo.ts#L96)
     - [`findByCoreUserId`](../src/back/storage/accounts.repo.ts#L112) / [`findByCoreUserIds`](../src/back/storage/accounts.repo.ts#L125) (consulta en lote para cruzar `audience` de `xchanger:events`)
     - [`updateRotatedSession`](../src/back/storage/accounts.repo.ts#L138) (rotación de `refreshToken`)
     - [`deleteByTelegramUserId`](../src/back/storage/accounts.repo.ts#L154) / [`deleteByCoreUserId`](../src/back/storage/accounts.repo.ts#L162) / [`deleteBySessionId`](../src/back/storage/accounts.repo.ts#L170)

3. **Conexión y almacenes en Redis bajo prefijo `tg:*` ([`redis.ts`](../src/back/config/redis.ts), [`redis-stores.ts`](../src/back/storage/redis-stores.ts))**
   - Cliente compartido [`getRedis`](../src/back/config/redis.ts#L7), fábrica [`createRedisConnection`](../src/back/config/redis.ts#L18) y [`closeRedis`](../src/back/config/redis.ts#L29). Todas las claves usan el prefijo `tg:*` exigido por la ACL de Redis (§11).
   - [`RedisStateStore`](../src/back/storage/redis-stores.ts#L48) (`implements StateStore`): guarda estado conversacional en `tg:state:<chatId>` con TTL de **15 min** (900 s) — [`get`](../src/back/storage/redis-stores.ts#L55), [`set`](../src/back/storage/redis-stores.ts#L60), [`clear`](../src/back/storage/redis-stores.ts#L68).
   - [`RedisCallbackStore`](../src/back/storage/redis-stores.ts#L77) (`implements CallbackStore`): genera claves cortas `cb:<16_hex>` (19 bytes `< 64` bytes límite de Telegram) guardadas en `tg:cb:<16_hex>` con TTL de **24 h** — [`encode`](../src/back/storage/redis-stores.ts#L84), [`decode`](../src/back/storage/redis-stores.ts#L90).
   - [`RedisPendingLinkStore`](../src/back/storage/redis-stores.ts#L103): guarda temporalmente el `deviceCode` en `tg:link:<externalUserId>` (TTL **10 min**) para canjearlo al recibir `channel.link.approved` — [`save`](../src/back/storage/redis-stores.ts#L110), [`get`](../src/back/storage/redis-stores.ts#L118), [`consume`](../src/back/storage/redis-stores.ts#L127).
   - [`RedisDedupStore`](../src/back/storage/redis-stores.ts#L138): deduplicación atómica (`SET ... NX EX`) de `update_id` de Telegram (`tg:upd:*`) y `event.id` de Redis Streams (`tg:evt:done:*`) durante **24 h** — [`markTelegramUpdateOnce`](../src/back/storage/redis-stores.ts#L145), [`isEventProcessed`](../src/back/storage/redis-stores.ts#L153), [`markEventProcessed`](../src/back/storage/redis-stores.ts#L157).


   

### Verificación

Comandos ejecutados en `telegram-bot/`:

```bash
npm run typecheck   # tsc --noEmit (src/ y test/) -> 0 errores
npm test            # test/block1.spec.ts -> 1 suite, 9/9 tests pasados
npm run build       # tsc --project tsconfig.build.json -> dist/index.js generado
```

### Mapa de archivos (Bloque 1)

| Archivo | Qué hace |
| :--- | :--- |
| [`env.ts`](../src/back/config/env.ts) | Valida con Zod todas las variables de `.env` al arrancar (exige secretos si `USE_MOCK_CORE=false`). |
| [`db.ts`](../src/back/config/db.ts) | Abre el pool de PostgreSQL (`bot-db`) y crea automáticamente la tabla `telegram_accounts` e índices si no existen. |
| [`redis.ts`](../src/back/config/redis.ts) | Crea y cierra las conexiones `ioredis` hacia Redis (cliente compartido y fábrica para conexiones bloqueantes). |
| [`token-cipher.ts`](../src/back/crypto/token-cipher.ts) | Cifra y descifra los `refreshToken` con `AES-256-GCM` + IV aleatorio + AAD ligado al `telegramUserId`. |
| [`accounts.repo.ts`](../src/back/storage/accounts.repo.ts) | Consultas SQL parametrizadas a `telegram_accounts` (guardar, leer descifrado, buscar por lote, rotar y borrar). |
| [`redis-stores.ts`](../src/back/storage/redis-stores.ts) | Implementa en Redis bajo prefijo `tg:*` los 4 almacenes: estado conversacional, botones cortos, vinculaciones pendientes y deduplicación. |
| [`contracts.ts`](../src/contracts.ts) | Interfaces compartidas entre Back y Front (`CoreClient`, `StateStore`, `CallbackStore`, `BotEventHandlers`). |
| [`index.ts`](../src/index.ts) | Punto de entrada (`createBackServices`) que entrega `{ core, state, callbacks }` al Front (en modo mock o real). |
| [`block1.spec.ts`](../test/block1.spec.ts) | 9 pruebas unitarias de Jest que validan cifrado, almacenes Redis y repositorio `bot-db` sin dependencias externas. |
| [`tsconfig.json`](../tsconfig.json) / [`tsconfig.build.json`](../tsconfig.build.json) | `tsconfig.json` valida tipos en `src/` + `test/`; `tsconfig.build.json` compila solo `src/` a `dist/` para producción. |
| [`jest.config.js`](../jest.config.js) | Configura Jest con `ts-jest` para ejecutar los tests TypeScript de `test/*.spec.ts`. |

