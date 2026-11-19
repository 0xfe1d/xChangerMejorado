import { env } from './config/env';
import { CallbackStore, CoreClient, StateStore } from './contracts';
import { MockCoreClient } from './mocks/mock-core.client';
import { MemoryCallbackStore, MemoryStateStore } from './state/memory-stores';
import { registerCommands } from './handlers/command';
import { registerTextHandler } from './handlers/text';
import { registerCallbackHandlers } from './handlers/callback';

declare const require: (moduleName: string) => unknown;
declare const console: { log(...data: unknown[]): void; error(...data: unknown[]): void; };
declare const process: { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void; };

const { Telegraf } = require('telegraf') as {
  Telegraf: new (token: string) => any;
}

export * from './contracts';

export interface BackServices {
  core: CoreClient;
  state: StateStore;
  callbacks: CallbackStore;
}

/**
 * Inicializa los servicios de infraestructura del microservicio
 * (cliente del core y almacenes de estado y callbacks).
 */
export function createBackServices(): BackServices {
  if (!env.USE_MOCK_CORE) {
    throw new Error('El modo real (USE_MOCK_CORE=false) aún no está implementado. Usa USE_MOCK_CORE=true.');
  }

  const core: CoreClient = new MockCoreClient();
  const state: StateStore = new MemoryStateStore();
  const callbacks: CallbackStore = new MemoryCallbackStore();
  return { core, state, callbacks };
}

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
const services = createBackServices();

// Middleware para loguear información de cada update recibido y el tiempo que tarda en procesarse. 
bot.use(async (ctx: any, next: () => Promise<void>) => {
  const start = Date.now();
  const user = ctx.from;
  console.log(`[Telegram] Update: ${ctx.updateType} | User: ${user?.id} (@${user?.username || 'sin_username'})`);
  await next();
  console.log(`[Telegram] Handled in ${Date.now() - start}ms`);
});

registerCommands(bot, services);
registerTextHandler(bot, services);
registerCallbackHandlers(bot, services);

bot.catch((err: unknown, ctx: any) => {
  console.error(`Error en el bot de Telegram: ${err}`);
});


// ---- Arranque del bot ----
bot.launch()
  .then(() => {
    console.log(`Bot de Telegram de xChanger arrancado (Mock Mode: ${env.USE_MOCK_CORE})`);
  })
  .catch((error: unknown) => {
    console.error('Error al iniciar el bot:', error);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));