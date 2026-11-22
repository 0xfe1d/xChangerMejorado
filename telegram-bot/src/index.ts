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
  onUpdate: (update: TelegramUpdate) => Promise<void> | void;
  eventHandlers?: BotEventHandlers;
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
  const services = createBackServices(cfg);
  let consumer: RedisEventStreamConsumer | null = null;

  if (!cfg.USE_MOCK_CORE) {
    await initBotDatabase();

    if (
      options.eventHandlers &&
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
        handlers: options.eventHandlers,
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
    onUpdate: options.onUpdate,
    checkRedis: cfg.USE_MOCK_CORE
      ? async () => true
      : async () => (await getRedis().ping().catch(() => '')) === 'PONG',
    checkCore: cfg.USE_MOCK_CORE ? async () => true : () => pingCoreHealth(cfg.CORE_API_URL),
    getConsumerLagMs: () => consumer?.getConsumerLagMs() ?? 0,
  });

  const port = await server.listen(options.port ?? cfg.PORT);

  const stop = async () => {
    await consumer?.stop();
    await server.close();
    if (!cfg.USE_MOCK_CORE) {
      await Promise.all([closeRedis(), closeBotDb()]);
    }
  };

  return { services, server, port, stop };
}

if (require.main === module) {
  startBotRuntime({
    onUpdate: () => undefined,
  })
    .then((runtime) => {
      console.log(
        `[telegram-bot] escuchando en puerto ${runtime.port} (USE_MOCK_CORE=${env.USE_MOCK_CORE})`,
      );
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
