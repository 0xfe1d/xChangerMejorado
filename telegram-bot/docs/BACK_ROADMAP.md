# Hoja de Ruta y Reglas — Backend `telegram-bot`

Rama de trabajo: `feat/telegram-bot-back`  
Referencia arquitectónica: [xchanger_escalado.pdf](../../docs/xchanger_escalado.pdf) (§6, §9, §11 y §12)  
Detalle de lo ya implementado: [BACK_PROGRESS.md](./BACK_PROGRESS.md)

---

## Bloques de Implementación

- [x] **Bloque 1 — Cifrado, `bot-db` y Almacenes en Redis**
  - `TokenCipher` (AES-256-GCM + AAD), `telegram_accounts` (`pg`), almacenes Redis bajo `tg:*` (`StateStore`, `CallbackStore`, `PendingLinkStore`, `DedupStore`) y tests unitarios.
- [x] **Bloque 2 — Autenticación de Servicio y Sesiones de Canal**
  - `ServiceAuthManager` (`EP-C-01`, renovación automática cuando quedan `< 60 s`) y `ChannelSessionManager` (`accessToken` en Redis + rotación de `refreshToken` en `bot-db` con lock distribuido).
- [x] **Bloque 3 — `HttpCoreClient` (REST `/api/v1` + Caché)**
  - Transporte HTTP base (`X-Service-Authorization`, `Authorization`, `X-Request-Id`, `Idempotency-Key`, `CoreApiError`, reintento único ante `401 TOKEN_EXPIRED`), los 31 métodos de `CoreClient` y caché de catálogo (TTL 5 min).
- [x] **Bloque 4 — Consumidor de Eventos (`xchanger:events`)**
  - Grupo `telegram-bot` en Redis Streams (`XREADGROUP` + `XAUTOCLAIM`), deduplicación por `event.id`, filtro estricto por `audience`, reacción a eventos internos (`channel.link.approved`, `channel.session.revoked`, `account.blocked`, `academic.changed`) y disparo de `BotEventHandlers`.
- [x] **Bloque 5 — Cola de Salida y Servidor HTTP (`Webhook` + `/healthz`)**
  - `OutboundQueue` (30 msg/s global, 1 msg/s por chat, manejo de `429 retry_after`), `POST /telegram/webhook` (`EP-B-01`, `X-Telegram-Bot-Api-Secret-Token`, dedup `update_id`, `200` inmediato), `GET /healthz` (`EP-B-02`) y cableado en [`index.ts`](../src/index.ts).
- [x] **Bloque 6 — Docker, Nginx e Integración**
  - `Dockerfile` en dos etapas, servicios `telegram-bot` y `bot-db` en [`docker-compose.yml`](../../docker-compose.yml), ruta `POST /telegram/webhook` en Nginx y pruebas de integración.

---

## Reglas del Proyecto (para no desviarnos)

1. Todo el código de infraestructura va en `telegram-bot/src/back/` (sin tocar `src/front/`).
2. Mantener `USE_MOCK_CORE=true` operativo en todo momento para el desarrollo del Front.
3. Cada bloque incluye su suite de tests unitarios en `telegram-bot/test/` y debe pasar `npm run typecheck`, `npm test` y `npm run build`.
4. Al cerrar cada bloque, se marca su casilla aquí y se añade su sección independiente al final de [BACK_PROGRESS.md](./BACK_PROGRESS.md) (qué se construyó, tabla de archivos propia y verificación propia, con enlaces `#L` directos y sin mezclar con bloques previos).
