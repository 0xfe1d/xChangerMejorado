import { env } from './config/env';
import { CallbackStore, CoreClient, StateStore } from './contracts';
import { MockCoreClient } from './mocks/mock-core.client';
import { MemoryCallbackStore, MemoryStateStore } from './state/memory-stores';

declare const require: (moduleName: string) => unknown;
declare const console: {
  log(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare const process: {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
};

export interface Context {
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  chat?: { id: number };
  updateType: string;
  reply(text: string, extra?: { parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML' }): Promise<unknown>;
}

interface TelegramBot {
  use(middleware: (ctx: Context, next: () => Promise<void>) => Promise<void>): this;
  command(command: string, handler: (ctx: Context) => Promise<void>): this;
  catch(handler: (err: unknown, ctx: Context) => void): this;
  launch(): Promise<void>;
  stop(reason?: string): void;
}

const { Telegraf } = require('telegraf') as {
  Telegraf: new (token: string) => TelegramBot;
};

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

const { core, state, callbacks } = createBackServices();

// Middleware para loguear información de cada update recibido y el tiempo que tarda en procesarse. 
bot.use(async (ctx, next) => {
  const start = Date.now();
  const user = ctx.from;
  console.log(`[Telegram] Update: ${ctx.updateType} | User: ${user?.id} (@${user?.username || 'sin_username'})`);
  await next();
  console.log(`[Telegram] Handled in ${Date.now() - start}ms`);
});


// ---- Comandos Iniciales ----
bot.command('start', async (ctx: Context) => {
  const externalUserId = ctx.from?.id.toString() || '';
  if (!externalUserId) return;

  try {
    const linked = await core.isLinked(externalUserId);

    if (linked) {
      await ctx.reply('¡Ya estás vinculado! Puedes usar los comandos disponibles.');
    } else {
      await ctx.reply('¡Bienvenido!\n\n' +
        '• /vincular - Enlazar con la web\n' +
        '• /entrar - Iniciar sesión por OTP\n' +
        '• /registro - Alta de cuenta nueva',
        { parse_mode: 'Markdown'}
      );
    }
  } catch (error) {
    console.error('Error al verificar el estado de vinculación:', error);
    await ctx.reply('Ocurrió un error al verificar tu estado de vinculación. Por favor, inténtalo de nuevo más tarde.');
  }
});

bot.command('vincular', async (ctx: Context) => {
  const user = ctx.from;
  const chat = ctx.chat;
  if (!user || !chat) return;

  try {
    const linkData = await core.createLinkRequest({
      externalUserId: user.id.toString(),
      chatId: chat.id.toString(),
      displayName: [user.first_name, user.last_name].filter(Boolean).join(' '),
      username: user.username || undefined,
    });

    await ctx.reply(`**Solicitud de vinculación creada**\n\n` +
      `Código de dispositivo: \`${linkData.deviceCode}\`\n` +
      `Código de usuario: **${linkData.userCode}**\n\n` +
      `Aprueba la vinculación en el siguiente enlace:\n${linkData.verificationUriComplete}`,
      { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error al crear la solicitud de vinculación:', error);
    await ctx.reply('Ocurrió un error al crear la solicitud de vinculación. Por favor, inténtalo de nuevo más tarde.');
  }
});

bot.catch((err, ctx) => {
  console.error(`Error en el bot de Telegram: ${err}`);
});


// ---- Arranque del bot ----
bot.launch()
  .then(() => {
    console.log(`Bot de Telegram de xChanger arrancado (Mock Mode: ${env.USE_MOCK_CORE})`);
  })
  .catch((error) => {
    console.error('Error al iniciar el bot:', error);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));