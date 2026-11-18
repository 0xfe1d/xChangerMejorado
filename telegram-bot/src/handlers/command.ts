import { BackServices } from '../index';

export interface TelegramContext {
    from?: {
        id: number;
        first_name: string;
        last_name?: string;
        username?: string;
    };
    chat?: { 
        id: number;
        type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    message?: {
        message_id: number;
        text?: string;
    };
    updateType: string;
    reply(text: string, extra?: { parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML' }): Promise<unknown>;
    deleteMessage(messageId: number): Promise<boolean>;
}

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

    // Manejador de texto y eliminador de mensajes OPT y MFA - RF-TGB-13
    bot.on('text', async (ctx: TelegramContext) => {
        const text = ctx.message?.text?.trim();
        const user = ctx.from;
        const chat = ctx.chat;
        if (!text || !user || !chat) return;

        if (text.startsWith('/')) return;

        const chatId = chat.id.toString();
        const externalUserId = user.id.toString();
        const currentState = await state.get(chatId);

        if (!currentState) {
            await ctx.reply('No hay ninguna operación en curso. Usa /start o /ayuda para obtener más información.');
            return;
        }

        const tgIdentify = {
            externalUserId,
            chatId,
            displayName: [user.first_name, user.last_name].filter(Boolean).join(' '),
            username: user.username || undefined,
        };

        try {
            // Recibir email y enviar OTP
            if (currentState.step === 'ENTRAR:ESPERANDO_EMAIL') {
                const email = text.toLowerCase();
                if (!email.includes('@')) {
                    await ctx.reply('El correo electrónico ingresado no es válido. Por favor, inténtalo de nuevo o escribe /cancelar para salir.');
                    return;
                }

                const challenge = await core.sendEmailOtp(externalUserId, email);
                await state.set(
                    chatId, 
                    { 
                        step: 'ENTRAR:ESPERANDO_OTP', 
                        data: { challengeToken: challenge.challengeToken, email },
                    },
                    challenge.expiresIn
                );

                await ctx.reply(`Se ha enviado un código OTP de ${challenge.codeLength} dígitos a tu correo electrónico (${email}). Por favor, ingresa el código recibido (o escribe /cancelar para salir):`, 
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // Recibir OTP
            if (currentState.step === 'ENTRAR:ESPERANDO_OTP') {
                await ctx.deleteMessage(ctx.message!.message_id).catch(() => {});

                const challengeToken = currentState.data.challengeToken as string;
                const authResult = await core.verifyEmailOtp(tgIdentify, challengeToken, text);

                if (authResult.kind === 'session') {
                    await state.clear(chatId);
                    await ctx.reply(`¡Inicio de sesión exitoso! Ahora estás vinculado y puedes usar los comandos disponibles. ¡Bienvenido/a **${authResult.user.name}**!`, { 
                        parse_mode: 'Markdown', 
                    });
                } else if (authResult.kind === 'mfa_required') {
                    await state.set(
                        chatId, 
                        { 
                            step: 'ENTRAR:ESPERANDO_MFA', 
                            data: { challengeToken: authResult.challengeToken },
                        },
                        authResult.expiresIn
                    );
                    await ctx.reply(`Se requiere autenticación multifactor (MFA). Por favor, ingresa el código MFA recibido (o escribe /cancelar para salir):`,
                        { parse_mode: 'Markdown' }
                    );
                }
                return;
            }

            // Recibir MFA
            if (currentState.step === 'ENTRAR:ESPERANDO_MFA') {
                await ctx.deleteMessage(ctx.message!.message_id).catch(() => {});

                const challengeToken = currentState.data.challengeToken as string;
                const factor = text.length <= 8 ? { code: text } : { recoveryCode: text };
                const session = await core.verifyMfa(tgIdentify, challengeToken, factor);

                await state.clear(chatId);
                await ctx.reply(`¡Inicio de sesión exitoso! Ahora estás vinculado y puedes usar los comandos disponibles. ¡Bienvenido/a **${session.user.name}**!`, { 
                    parse_mode: 'Markdown', 
                });
                return;
            }
        } catch (error: any) {
            const errorMSG = error?.message || 'Codigo invalido o expirado. Por favor, inténtalo de nuevo.';
            await ctx.reply(`Ocurrió un error: ${errorMSG}. Por favor, inténtalo de nuevo más tarde o escribe /cancelar para salir.`);
        }
    });
}