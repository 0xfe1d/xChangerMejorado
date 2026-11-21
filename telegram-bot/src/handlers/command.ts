import { BackServices } from '../index';
import { TelegramContext } from '../types/telegram';
import { enterOfferChat, sendExpedienteView, sendMyOffersView, sendNotificationsView, startOfferFlow } from './callback';

// Comandos principales del bot telegram
export function registerCommands(bot: any, services: BackServices) {
    const { core, state, callbacks } = services;
    const commandNames = new Set([
        'start',
        'vincular',
        'cancelar',
        'entrar',
        'perfil',
        'desvincular',
        'ayuda',
        'registro',
        'expediente',
        'buscar',
        'ofertar',
        'misofertas',
        'chat',
        'salir',
        'notificaciones',
    ]);

    // RF-TGB-12: Solo operar en chats privados
    bot.use(async (ctx: TelegramContext, next: () => Promise<void>) => {
        if (ctx.chat?.type && ctx.chat.type !== 'private') {
            await ctx.reply('Este bot solo funciona en chats privados. Por favor, envíame un mensaje directo.');
            return;
        }
        await next();
    });

    // Un comando nuevo abandona el flujo conversacional actual. /salir necesita
    // conservarlo para comprobar si el usuario estaba dentro de un chat.
    bot.use(async (ctx: TelegramContext, next: () => Promise<void>) => {
        const text = ctx.message?.text;
        const chatId = ctx.chat?.id.toString();
        const command = text?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i)?.[1].toLowerCase();
        if (chatId && commandNames.has(command ?? '') && command !== 'cancelar' && command !== 'salir') {
            await state.clear(chatId);
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
            '• /notificaciones - Revisar avisos y preferencias\n' +
            '**Gestión Chat:**\n' +
            '• /chat - Entrar al chat de una oferta aceptada\n' +
            '• /cancelar - Cancelar la operación en curso\n' +
            '• /salir - Salir del modo chat',
            { parse_mode: 'Markdown' }
        );
    });

    // Comando /registro RF-TGB-03
    bot.command('registro', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (linked) {
                await ctx.reply('Ya tienes una cuenta vinculada en este chat. Usa /desvincular primero si deseas cambiar de cuenta.');
                return;
            }

            await state.set(chatId, {step: 'REGISTRO:ESPERANDO_NOMBRE', data: {} }, 900);
            await ctx.reply(
                '**Registro en xChanger**\n\n' + 
                'Escribe tu **nombre completo** (o /cancelar para salir):',
                { parse_mode: 'Markdown'}
            );
        } catch {
            await ctx.reply('No se pudo iniciar el registro en este momento. Inténtalo de nuevo mas tarde.');
        }
    })

    // Comando /expediente RF-TGB-04
    bot.command('expediente', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            await sendExpedienteView(ctx, core, callbacks, externalUserId);
        } catch {
            await ctx.reply('No se pudo cargar tu expediente. Inténtalo de nuevo más tarde.');
        }
    });

    // Comando /buscar RF-TGB-05
    bot.command('buscar', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            await startOfferFlow(ctx, core, state, callbacks, chatId, externalUserId, 'search');
        } catch {
            await ctx.reply('No se pudo iniciar la búsqueda de ofertas. Inténtalo de nuevo más tarde.');
        }
    });

    // Comando /ofertar EP-R-10
    bot.command('ofertar', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            await startOfferFlow(ctx, core, state, callbacks, chatId, externalUserId, 'create');
        } catch {
            await ctx.reply('No se pudo iniciar la creación de oferta. Inténtalo de nuevo más tarde.');
        }
    });

    // Comando /misofertas
    bot.command('misofertas', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            await sendMyOffersView(ctx, core, callbacks, externalUserId);
        } catch {
            await ctx.reply('No se pudieron cargar tus ofertas. Inténtalo de nuevo más tarde.');
        }
    });

    // Comando /chat
    bot.command('chat', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        const chatId = ctx.chat?.id.toString();
        if (!externalUserId || !chatId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            const argsText = (ctx.message?.text ?? '').replace(/^\/chat(?:@\w+)?/i, '').trim();
            const myOffers = await core.listMyOffers(externalUserId, { status: ['ACCEPTED'] });

            if (myOffers.items.length === 0) {
                await ctx.reply('No tienes ninguna oferta en estado **ACCEPTED** con chat disponible.', {
                    parse_mode: 'Markdown',
                });
                return;
            }

            const target = argsText
                ? myOffers.items.find((o) => o.id === argsText)
                : myOffers.items.length === 1
                    ? myOffers.items[0]
                    : undefined;

            if (!target) {
                const rows = await Promise.all(
                    myOffers.items.map(async (o) => [
                        {
                            text: `Chat: ${o.asignatura.codigo} (${o.grupoActual.nombre} ⇄ ${o.grupoDeseado.nombre})`,
                            callback_data: await callbacks.encode({ action: 'myoff:chat', data: { offerId: o.id } }, 900),
                        },
                    ]),
                );

                await ctx.reply('Tienes varias ofertas aceptadas. Elige a cuál quieres entrar:', {
                    reply_markup: { inline_keyboard: rows },
                });
                return;
            }

            await enterOfferChat(ctx, core, state, chatId, externalUserId, target.id);
        } catch {
            await ctx.reply('No se pudo abrir el chat de la oferta. Inténtalo de nuevo más tarde.');
        }
    });

    // Comando /salir
    bot.command('salir', async (ctx: TelegramContext) => {
        const chatId = ctx.chat?.id.toString();
        if (!chatId) return;

        const current = await state.get(chatId);
        if (current?.step === 'CHAT:ACTIVO') {
            await state.clear(chatId);
            await ctx.reply('Has salido del modo chat.');
        } else {
            await ctx.reply('No estabas dentro de ningún chat activo.');
        }
    });

    // Comando /notificaciones
    bot.command('notificaciones', async (ctx: TelegramContext) => {
        const externalUserId = ctx.from?.id.toString();
        if (!externalUserId) return;

        try {
            const linked = await core.isLinked(externalUserId);
            if (!linked) {
                await ctx.reply('No estás vinculado. Usa /vincular o /entrar primero.');
                return;
            }

            await sendNotificationsView(ctx, core, callbacks, externalUserId);
        } catch {
            await ctx.reply('No se pudieron cargar las notificaciones. Inténtalo de nuevo más tarde.');
        }
    });
}