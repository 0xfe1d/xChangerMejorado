import { BackServices } from '../index';

export interface TelegramContext {
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

// Comandos principales del bot telegram
export function registerCommands(bot: any, services: BackServices) {
    const { core, state, callbacks } = services;

    // Comando /start RA-12
    bot.command('start', async (ctx: TelegramContext) => {
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
        await ctx.reply('Ocurrió un error al verificar tu estado de vinculación. Por favor, inténtalo de nuevo más tarde.');
      }
    });

    // Comando /vincular RF-TGB-01
    bot.command('vincular', async (ctx: TelegramContext) => {
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
  } catch {
    await ctx.reply('Ocurrió un error al crear la solicitud de vinculación. Por favor, inténtalo de nuevo más tarde.');
  }
});
}