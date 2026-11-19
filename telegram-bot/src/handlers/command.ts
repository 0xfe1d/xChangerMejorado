import { BackServices } from '../index';
import { TelegramContext } from '../types/telegram';

// Comandos principales del bot telegram
export function registerCommands(bot: any, services: BackServices) {
    const { core, state, callbacks } = services;

    // RF-TGB-12: Solo operar en chats privados
    bot.use(async (ctx: TelegramContext, next: () => Promise<void>) => {
        if (ctx.chat?.type && ctx.chat.type !== 'private') {
            await ctx.reply('Este bot solo funciona en chats privados. Por favor, envíame un mensaje directo.');
            return;
        }
        await next();
    });

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

    // Comando /cancelar
    bot.command('cancelar', async (ctx: TelegramContext) => {
        const chatId = ctx.chat?.id.toString();
        if (!chatId) return;
        await state.clear(chatId);
        await ctx.reply('Solicitud cancelada.');
    });

    // Comando /entrar RF-TGB-02
    bot.command('entrar', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        const linked = await core.isLinked(externalUserId);
        if (linked) {
            await ctx.reply('¡Ya estás vinculado! Puedes usar /desvincular para desvincularte o continuar usando los comandos disponibles.');
            return;
        }
        
        await state.set(chatId, { step: 'ENTRAR:ESPERANDO_EMAIL', data: {} }, 900);
        await ctx.reply('Por favor, ingresa tu correo electrónico para iniciar sesión (o escribe /cancelar para salir):', { parse_mode: 'Markdown' });
    });

    // Comando /perfil EP-R-04, EP-C-20
    bot.command('perfil', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        if (!externalUserId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular para enlazar tu cuenta o /entrar para iniciar sesión.');
                return;
            }

            const profile = await core.getProfile(externalUserId);
            const mfa = (profile as typeof profile & { mfa?: { enabled?: boolean } }).mfa;

            await ctx.reply(`**Perfil de usuario**\n\n` +
                `Nombre: **${profile.name}**\n` +
                `Correo electrónico: **${profile.email}**\n` +
                `Rol: ${profile.role}\n` +
                `MFA: ${mfa?.enabled ? 'Activado' : 'Desactivado'}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            await ctx.reply('Ocurrió un error al obtener tu perfil. Por favor, inténtalo de nuevo más tarde.');
        }
    });

    // Comando /desvincular RF-TGB-09, EP-C-09
    bot.command('desvincular', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No tienes ninguna sesión vinculada actualmente.');
                return;
            }

            await core.revoke(externalUserId, 'identity');
            await state.clear(chatId);

            await ctx.reply('Tu sesión ha sido desvinculada exitosamente. Si deseas volver a vincularte, usa /vincular o /entrar.');
        } catch (error) {
            await ctx.reply('Ocurrió un error al intentar desvincular tu sesión. Por favor, inténtalo de nuevo más tarde.');
        }
    });

    // Comando /ayuda
    bot.command('ayuda', async (ctx: TelegramContext) => {
        await ctx.reply('**Comandos disponibles:**\n\n' +
            '**Cuenta y Acceso:**\n' +
            '• /start - Menú de bienvenida\n' +
            '• /vincular - Enlazar cuenta mediante código web\n' +
            '• /entrar - Iniciar sesión con correo y OTP\n' +
            '• /registro - Crear cuenta nueva sin contraseña\n' +
            '• /perfil - Ver tus datos y estado MFA\n' +
            '• /desvincular - Cerrar sesión y desvincular Telegram\n\n' +
            '**Gestión Académica y Ofertas:**\n' +
            '• /expediente - Consultar y editar tus asignaturas\n' +
            '• /buscar - Buscar ofertas de cambio de grupo\n' +
            '• /ofertar - Publicar una oferta directamente\n' +
            '• /misofertas - Ver tus ofertas activas o aceptadas\n' +
            '• /chat - Entrar al chat de una oferta aceptada\n' +
            '• /notificaciones - Revisar avisos y preferencias\n' +
            '• /cancelar - Cancelar la operación en curso',
            { parse_mode: 'Markdown' }
        );
    });
}