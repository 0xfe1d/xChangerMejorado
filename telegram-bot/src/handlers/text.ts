import { BackServices } from '../index';
import { TelegramContext } from '../types/telegram';
import { showCarreraPage, showSubjectCandidates } from './callback';

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

            // Registro - Nombre
            if (currentState.step === 'REGISTRO:ESPERANDO_NOMBRE') {
                if (text.length < 2) {
                    await ctx.reply('El nombre es demasiado corto. Escribe tu nombre completo o /cancelar:');
                    return;
                }

                await state.set(
                    chatId,
                    {
                        step: 'REGISTRO:ESPERANDO_EMAIL',
                        data: { ...currentState.data, name: text },
                    },
                    900
                );

                await ctx.reply('Escribe tu **correo electrónico** (o /cancelar para salir):', {
                    parse_mode: 'Markdown',
                });
                return;
            }

            // Registro - Email
            if (currentState.step === 'REGISTRO:ESPERANDO_EMAIL') {
                const email = text.toLowerCase();
                if (!email.includes('@')) {
                    await ctx.reply('El correo no es valido. Inténta de nuevo o escribe /cancelar:');
                    return;
                }

                await state.set(
                    chatId,
                    {
                        step: 'REGISTRO:ELEGIR_CARRERA',
                        data: { ...currentState.data, email},
                    },
                    900
                );

                await showCarreraPage(ctx, core, services.callbacks, chatId, 0);
                return;
            }

            // Registro - OTP alta RF-TGB-13
            if (currentState.step === 'REGISTRO:ESPERANDO_OTP') {
                if (ctx.message?.message_id) {
                    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
                }

                const challengeToken = currentState.data.challengeToken as string;
                const carreraId = currentState.data.carreraId as string | undefined;
                const cursoId = currentState.data.cursoId as string | undefined;

                const session = await core.verifyRegistrationOtp(tgIdentify, challengeToken, text);
                await state.set(
                    chatId,
                    {
                        step: 'REGISTRO:ASIGNATURAS_INICIALES',
                        data: {
                            userId: session.user.id,
                            carreraId,
                            cursoId,
                            addedSubjectIds: [],
                            subjectQuery: '',
                        },
                    },
                    900
                );

                await ctx.reply(
                    `¡Cuenta creada y sesión iniciada para **${session.user.name}**!\n\n` +
                    'Añade **al menos una asignatura** a tu expediente. ' +
                    'Escribe parte del nombre o código de la asignatura para buscarla:',
                    { parse_mode: 'Markdown' }
                );
                await showSubjectCandidates(ctx, core, services.callbacks, {
                    q: '',
                    carreraId,
                    cursoId,
                    page: 0,
                });
                return;
            }

            // Registro - Busqueda asignaturas 
            if (currentState.step === 'REGISTRO:ASIGNATURAS_INICIALES') {
                const carreraId = currentState.data.carreraId as string | undefined;
                const cursoId = currentState.data.cursoId as string | undefined;

                await state.set(
                    chatId,
                    {
                        step: 'REGISTRO:ASIGNATURAS_INICIALES',
                        data: { ...currentState.data, subjectQuery: text },
                    },
                    900
                );

                await showSubjectCandidates(ctx, core, services.callbacks, {
                    q: text,
                    carreraId,
                    cursoId,
                    page: 0,
                });
                return;
            }
        } catch (error: any) {
            const errorMSG = error?.message || 'Codigo invalido o expirado. Por favor, inténtalo de nuevo.';
            await ctx.reply(`Ocurrió un error: ${errorMSG}. Por favor, inténtalo de nuevo más tarde o escribe /cancelar para salir.`);
        }
    });
};