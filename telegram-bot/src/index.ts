import { env } from './back/config/env';
import { closeBotDb, getBotDb, initBotDatabase } from './back/config/db';
import { closeRedis, createRedisConnection, getRedis } from './back/config/redis';
import { RedisCatalogCache } from './back/core/catalog-cache';
import { HttpCoreClient } from './back/core/http-core.client';
import { ServiceAuthManager } from './back/core/service-auth';
import { ChannelSessionManager } from './back/core/session-manager';
import { TokenCipher } from './back/crypto/token-cipher';
import { RedisEventStreamConsumer } from './back/events/event-consumer';
import { BotEventDispatcher } from './back/events/event-dispatcher';
import { BotHttpServer, TelegramUpdate } from './back/http/webhook-server';
import { MockCoreClient } from './back/mocks/mock-core.client';
import { MemoryCallbackStore, MemoryStateStore } from './back/state/memory-stores';
import { TelegramAccountsRepository } from './back/storage/accounts.repo';
import {
  RedisCallbackStore,
  RedisDedupStore,
  RedisPendingLinkStore,
  RedisStateStore,
} from './back/storage/redis-stores';
import { OutboundQueue } from './back/telegram/outbound-queue';
import { BotEventHandlers, CallbackStore, CoreClient, StateStore } from './contracts';
import { registerCommands } from './handlers/command';
import { createEventHandlers } from './handlers/events';
import { registerTextHandler } from './handlers/text';
import { registerCallbackHandlers } from './handlers/callback';

interface TelegramBot {
  use(handler: (ctx: any, next: () => Promise<void>) => Promise<void>): void;
  command(command: string, handler: (ctx: any) => Promise<void>): void;
  on(event: string, handler: (ctx: any) => Promise<void>): void;
  catch(handler: (error: unknown, ctx: any) => void): void;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  launch?: () => Promise<void>;
  stop?: (reason?: string) => void;
}

const { Telegraf } = require('telegraf') as {
  Telegraf: new (token: string) => TelegramBot;
};

export * from './contracts';
export { BotHttpServer, HealthzStatus, TelegramUpdate } from './back/http/webhook-server';
export { OutboundQueue, TelegramRateLimitError } from './back/telegram/outbound-queue';
export { HttpCoreClient } from './back/core/http-core.client';
export { RedisCatalogCache } from './back/core/catalog-cache';
export { ServiceAuthManager } from './back/core/service-auth';
export { ChannelSessionManager } from './back/core/session-manager';
export { BotEventDispatcher } from './back/events/event-dispatcher';
export { RedisEventStreamConsumer } from './back/events/event-consumer';

export type BotRuntimeConfig = typeof env;

export interface BackServices {
  core: CoreClient;
  state: StateStore;
  callbacks: CallbackStore;
  outbound: OutboundQueue;
  accountsRepo?: TelegramAccountsRepository;
  pendingLinks?: RedisPendingLinkStore;
  dedup?: RedisDedupStore;
  sessionManager?: ChannelSessionManager;
  catalogCache?: RedisCatalogCache;
}

export interface StartBotRuntimeOptions {
  onUpdate?: (update: TelegramUpdate) => Promise<void> | void;
  eventHandlers?: BotEventHandlers | ((services: BackServices) => BotEventHandlers);
  port?: number;
  config?: Partial<BotRuntimeConfig>;
}

export interface BotRuntime {
  services: BackServices;
  server: BotHttpServer;
  port: number;
  stop: () => Promise<void>;
}

async function pingCoreHealth(coreApiUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${coreApiUrl.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inicializa los servicios de infraestructura del microservicio.
 * Con `USE_MOCK_CORE=true` devuelve implementación en memoria; con `false`,
 * conecta `HttpCoreClient`, Redis (`tg:*`) y `bot-db`.
 */
export function createBackServices(overrides: Partial<BotRuntimeConfig> = {}): BackServices {
  const cfg: BotRuntimeConfig = { ...env, ...overrides };
  const outbound = new OutboundQueue({ botToken: cfg.TELEGRAM_BOT_TOKEN });

  if (cfg.USE_MOCK_CORE) {
    return {
      core: new MockCoreClient(),
      state: new MemoryStateStore(),
      callbacks: new MemoryCallbackStore(),
      outbound,
    };
  }

  const redis = getRedis();
  const db = getBotDb();
  const cipher = new TokenCipher(cfg.TOKEN_ENC_KEY);
  const accountsRepo = new TelegramAccountsRepository(db, cipher);

  const state = new RedisStateStore(redis);
  const callbacks = new RedisCallbackStore(redis);
  const pendingLinks = new RedisPendingLinkStore(redis);
  const dedup = new RedisDedupStore(redis);

  const serviceAuth = new ServiceAuthManager({
    coreApiUrl: cfg.CORE_API_URL,
    clientId: cfg.SERVICE_CLIENT_ID,
    clientSecret: cfg.SERVICE_CLIENT_SECRET,
  });
  const sessionManager = new ChannelSessionManager({
    coreApiUrl: cfg.CORE_API_URL,
    redis,
    accountsRepo,
    serviceAuth,
  });
  const catalogCache = new RedisCatalogCache(redis);
  const core = new HttpCoreClient({
    coreApiUrl: cfg.CORE_API_URL,
    serviceAuth,
    sessionManager,
    catalogCache,
    pendingLinks,
  });

  return {
    core,
    state,
    callbacks,
    outbound,
    accountsRepo,
    pendingLinks,
    dedup,
    sessionManager,
    catalogCache,
  };
}

/**
 * Arranca el runtime completo del microservicio: esquema `bot-db`, consumidor de
 * `xchanger:events` (si hay `eventHandlers`) y servidor HTTP (`/telegram/webhook`, `/healthz`).
 */
export async function startBotRuntime(options: StartBotRuntimeOptions): Promise<BotRuntime> {
  const cfg: BotRuntimeConfig = { ...env, ...options.config };
  if (!cfg.TELEGRAM_BOT_TOKEN && !options.onUpdate) {
    throw new Error('TELEGRAM_BOT_TOKEN es obligatorio cuando no se proporciona un manejador de updates');
  }
  const services = createBackServices(cfg);
  const bot = cfg.TELEGRAM_BOT_TOKEN ? createTelegramBot(cfg.TELEGRAM_BOT_TOKEN, services) : undefined;
  let consumer: RedisEventStreamConsumer | null = null;

  if (!cfg.USE_MOCK_CORE) {
    await initBotDatabase();

    const resolvedEventHandlers =
      typeof options.eventHandlers === 'function'
        ? options.eventHandlers(services)
        : options.eventHandlers;

    if (
      resolvedEventHandlers &&
      services.accountsRepo &&
      services.sessionManager &&
      services.pendingLinks &&
      services.catalogCache &&
      services.dedup
    ) {
      const dispatcher = new BotEventDispatcher({
        accountsRepo: services.accountsRepo,
        sessionManager: services.sessionManager,
        pendingLinkStore: services.pendingLinks,
        catalogCache: services.catalogCache,
        coreClient: services.core,
        handlers: resolvedEventHandlers,
      });
      consumer = new RedisEventStreamConsumer({
        redis: getRedis(),
        createBlockingClient: () => createRedisConnection('events-block'),
        dedupStore: services.dedup,
        dispatcher,
      });
      consumer.start();
    }
  }

  const server = new BotHttpServer({
    webhookSecret: cfg.TELEGRAM_WEBHOOK_SECRET,
    dedupStore: services.dedup,
    onUpdate: async (update) => {
      await bot?.handleUpdate(update);
      await options.onUpdate?.(update);
    },
    checkRedis: cfg.USE_MOCK_CORE
      ? async () => true
      : async () => (await getRedis().ping().catch(() => '')) === 'PONG',
    checkCore: cfg.USE_MOCK_CORE ? async () => true : () => pingCoreHealth(cfg.CORE_API_URL),
    getConsumerLagMs: () => consumer?.getConsumerLagMs() ?? 0,
  });

  const port = await server.listen(options.port ?? cfg.PORT);

  const stop = async () => {
    if (cfg.TELEGRAM_BOT_MODE === 'polling' && bot?.stop) {
      try {
        bot.stop('STOP');
      } catch {
        // ignorar si no estaba en polling activo
      }
    }
    await consumer?.stop();
    await server.close();
    if (!cfg.USE_MOCK_CORE) {
      await Promise.all([closeRedis(), closeBotDb()]);
    }
  };

  if (cfg.TELEGRAM_BOT_MODE === 'polling' && bot?.launch) {
    console.log('[telegram-bot] iniciando polling de Telegram...');
    bot.launch().catch((err) => {
      console.error('[telegram-bot] error al iniciar polling de Telegram:', err);
    });
  }

  return { services, server, port, stop };
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Menú de bienvenida' },
  { command: 'buscar', description: 'Buscar ofertas de cambio de grupo' },
  { command: 'ofertar', description: 'Publicar una oferta de cambio' },
  { command: 'misofertas', description: 'Ver tus ofertas activas e historial' },
  { command: 'expediente', description: 'Consultar y editar tus asignaturas' },
  { command: 'chat', description: 'Abrir el chat de una oferta aceptada' },
  { command: 'notificaciones', description: 'Revisar avisos y preferencias' },
  { command: 'perfil', description: 'Ver tus datos y estado MFA' },
  { command: 'vincular', description: 'Enlazar cuenta con la web' },
  { command: 'entrar', description: 'Iniciar sesión con correo y OTP' },
  { command: 'registro', description: 'Crear cuenta nueva desde Telegram' },
  { command: 'cancelar', description: 'Cancelar la operación en curso' },
  { command: 'salir', description: 'Salir del modo chat' },
  { command: 'desvincular', description: 'Cerrar sesión y desvincular Telegram' },
  { command: 'ayuda', description: 'Ver todos los comandos disponibles' },
];

if (require.main === module) {
  startBotRuntime({
    eventHandlers: (services) => createEventHandlers(services.outbound),
  })
    .then((runtime) => {
      console.log(
        `[telegram-bot] escuchando en puerto ${runtime.port} (USE_MOCK_CORE=${env.USE_MOCK_CORE}, MODE=${env.TELEGRAM_BOT_MODE})`,
      );
      if (env.TELEGRAM_BOT_TOKEN) {
        runtime.services.outbound
          .callTelegramApi('commands-init', 'setMyCommands', { commands: BOT_COMMANDS })
          .catch((err) => {
            console.error('[telegram-bot] no se pudo registrar menú de comandos:', err);
          });
      }
      if (
        env.TELEGRAM_BOT_MODE === 'webhook' &&
        env.TELEGRAM_BOT_TOKEN &&
        env.TELEGRAM_WEBHOOK_URL.startsWith('https://')
      ) {
        runtime.services.outbound
          .callTelegramApi('webhook-init', 'setWebhook', {
            url: env.TELEGRAM_WEBHOOK_URL,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          })
          .then(() => {
            console.log(`[telegram-bot] webhook registrado en ${env.TELEGRAM_WEBHOOK_URL}`);
          })
          .catch((err) => {
            console.error('[telegram-bot] no se pudo registrar webhook automáticamente:', err);
          });
      }
      const shutdown = () => {
        runtime
          .stop()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error('[telegram-bot] error fatal al iniciar:', err);
      process.exit(1);
    });
}

/**
 * Convierte sintaxis estilo CommonMark (`**negrita**`, `` `código` ``, `_cursiva_`) usada por los handlers
 * a HTML seguro de Telegram sin romper guiones bajos dentro de códigos, URLs o correos.
 */
export function markdownLikeToSafeHtml(text: string): string {
  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return text
    .split(/(`[^`]+`)/g)
    .map((segment) => {
      if (segment.startsWith('`') && segment.endsWith('`') && segment.length >= 2) {
        return `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
      }
      return escapeHtml(segment)
        .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    })
    .join('');
}

function createTelegramBot(token: string, services: BackServices): TelegramBot {
  const bot = new Telegraf(token);
  bot.use(async (ctx, next) => {
    const start = Date.now();
    const user = ctx.from;
    console.log(`[Telegram] Update: ${ctx.updateType} | User: ${user?.id} (@${user?.username || 'sin_username'})`);

    if (typeof ctx.reply === 'function') {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = async (text: string, extra?: Record<string, unknown>) => {
        if (typeof text === 'string' && extra?.parse_mode === 'Markdown') {
          const htmlExtra = { ...extra, parse_mode: 'HTML' as const };
          try {
            return await originalReply(markdownLikeToSafeHtml(text), htmlExtra);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.toLowerCase().includes("can't parse entities")) {
              const { parse_mode: _ignored, ...plainExtra } = extra;
              return await originalReply(text, plainExtra);
            }
            throw err;
          }
        }
        return await originalReply(text, extra);
      };
    }

    await next();
    console.log(`[Telegram] Handled in ${Date.now() - start}ms`);
  });

  registerCommands(bot, services);
  registerTextHandler(bot, services);
  registerCallbackHandlers(bot, services);
  bot.catch((error) => {
    console.error('[telegram-bot] error procesando update de Telegram:', error);
  });
  return bot;
}