import { BackServices } from '../index';
import { TelegramContext } from '../types/telegram';

// Manejador de texto y eliminador de mensajes OPT y MFA - RF-TGB-13
export const registerTextHandler = (bot: any, services: BackServices) => {
    const { core, state } = services;

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
                if (ctx.message?.message_id) {
                    await ctx.deleteMessage(ctx.message!.message_id).catch(() => {});
                }
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
};