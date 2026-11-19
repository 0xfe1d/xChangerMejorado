import { BackServices, CallbackPayload } from '../index';
import { TelegramContext } from '../types/telegram';

const PAGE_SIZE = 5;

export function registerCallbackHandlers(bot: any, services: BackServices) {
    const { core, state, callbacks } = services;

    bot.on('callback_query', async (ctx: TelegramContext) => {
        const dataKey = ctx.callbackQuery?.data;
        const user = ctx.from;
        const chat = ctx.chat;

        if (!dataKey || !user || !chat) return;

        const chatId = chat.id.toString();
        const externalUserId = user.id.toString();
        const updateId = (ctx as any).update?.update_id as number | undefined;

        const payload: CallbackPayload | null = await callbacks.decode(dataKey);
        if (!payload) {
            await ctx.answerCbQuery('Acción inválida o expirada. Por favor, inténtalo de nuevo.');
            return;
        }

        try {
            switch (payload.action) {
                case 'reg:carrera_page': {
                    const page = Number(payload.data.page ?? 0);
                    await showCarreraPage(ctx, core, callbacks, page);
                    await ctx.answerCbQuery();
                    break;
                }

                case 'reg:carrera_select': {
                    const carreraId = String(payload.data.carreraId);
                    const carreraNombre = String(payload.data.carreraNombre ?? '');
                    const current = await state.get(chatId);
                    const nextData = {
                        ...(current?.data ?? {}),
                        carreraId,
                        carreraNombre,
                    };

                    await state.set(chatId, { step: 'REGISTRO:ESPERANDO_CICLO', data: nextData }, 900);
                    await showCursoPage(ctx, core, callbacks, carreraId, 0);
                    await ctx.answerCbQuery(`Carrera: ${carreraNombre}`);
                    break;
                }

                case 'reg:curso_page': {
                    const carreraId = String(payload.data.carreraId);
                    const page = Number(payload.data.page ?? 0);
                    await showCursoPage(ctx, core, callbacks, carreraId, page);
                    await ctx.answerCbQuery();
                    break;
                }

                case 'reg:curso_select': {
                    const cursoId = String(payload.data.cursoId);
                    const cursoNombre = String(payload.data.cursoNombre ?? '');
                    const current = await state.get(chatId);
                    const regData = current?.data ?? {};

                    const name = String(regData.name ?? '');
                    const email = String(regData.email ?? '');
                    const carreraId = String(regData.carreraId ?? '');

                    if (!name || !email || !carreraId) {
                        await ctx.answerCbQuery('Faltan datos del registro.');
                        await ctx.reply('Datos incompletos del registro. Usa /cancelar y vuelve a empezar con /registro.');
                        return;
                    }

                    const challenge = await core.registerFromTelegram(
                        {
                            externalUserId,
                            name,
                            email,
                            carreraId,
                            cursoId,
                            acceptTerms: true,
                        },
                        { updateId },
                    );

                    await state.set(
                        chatId,
                        {
                            step: 'REGISTRO:ESPERANDO_OTP',
                            data: {
                                challengeToken: challenge.challengeToken,
                                email,
                                carreraId,
                                cursoId,
                                cursoNombre,
                            },
                        },
                        challenge.expiresIn,
                    );

                    await ctx.answerCbQuery();
                    await ctx.reply(
                        `Curso seleccionado: **${cursoNombre}**\n\n` +
                        `Se ha enviado un código de verificación de ${challenge.codeLength} digitos a **${email}**.\n` +
                        'Escribelo aquí para completar tu registro (o /cancelar): ',
                        { parse_mode: 'Markdown' },
                    );
                    break;
                }

                case 'reg:subj_search': {
                    const page = Number(payload.data.page ?? 0);
                    const current = await state.get(chatId);
                    const queryText = String(payload.data.q ?? current?.data?.subjectQuery ?? '');
                    const carreraId = current?.data?.carreraId as string | undefined;
                    const cursoId = current?.data?.cursoId as string | undefined;

                    await showSubjectCandidates(ctx, core, callbacks, {
                        q: queryText,
                        carreraId,
                        cursoId,
                        page,
                    });
                    await ctx.answerCbQuery();
                    break;
                }

                case 'reg:subj_add': {
                    const asignaturaId = String(payload.data.asignaturaId);
                    const codigo = String(payload.data.codigo ?? '');
                    const nombre = String(payload.data.nombre ?? '');

                    await core.addToExpediente(externalUserId, asignaturaId, { updateId });

                    const current = await state.get(chatId);
                    const addedIds = new Set<string>((current?.data?.addedSubjectIds as string[]) ?? []);
                    addedIds.add(asignaturaId);

                    await state.set(
                        chatId,
                        {
                            step: 'REGISTRO:ASIGNATURAS_INICIALES',
                            data: {
                                ...(current?.data ?? {}),
                                addedSubjectIds: Array.from(addedIds),
                            },
                        },
                        900,
                    );

                    await ctx.answerCbQuery(`Añadida ${codigo}`);
                    await ctx.reply(
                        `Asignatura añadida a tu expediente: **${codigo} — ${nombre}** (${addedIds.size} seleccionada(s)).\n` +
                        'Puedes buscar otra asignatura escribiendo su nombre o código, o pulsar **Finalizar registro** cuando tengas al menos una.',
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{
                                    text: 'Finalizar registro',
                                    callback_data: await callbacks.encode({ action: 'reg:finish_subjects', data: {} }, 900),
                                }]],
                            },
                        },
                    );
                    break;
                }

                case 'reg:finish_subjects': {
                    const expediente = await core.getExpediente(externalUserId);
                    if (!expediente || expediente.length === 0) {
                        await ctx.answerCbQuery('Debes añadir al menos 1 asignatura');
                        await ctx.reply(
                            'Necesitas añadir **al menos una asignatura** a tu expediente antes de continuar. Escribe un término de búsqueda (ej. `Programación` o `Estructuras`).',
                            { parse_mode: 'Markdown' },
                        );
                        return;
                    }

                    await state.clear(chatId);
                    await ctx.answerCbQuery('Registro completado');
                    await ctx.reply(
                        `¡Registro completado con **${expediente.length}** asignatura(s) en tu expediente!\n` +
                        'Ya puedes usar /expediente, /buscar, /ofertar o /ayuda.',
                        { parse_mode: 'Markdown' },
                    );
                    break;
                }

                case 'reg:subj_search_all': {
                    const current = await state.get(chatId);
                    const queryText = String(payload.data.q ?? current?.data?.subjectQuery ?? '');
                    const carreraId = current?.data?.carreraId as string | undefined;

                    await showSubjectCandidates(ctx, core, callbacks, {
                        q: queryText,
                        carreraId,
                        cursoId: undefined,
                        page: 0,
                    });
                    await ctx.answerCbQuery();
                    break;
                }

                // ---- EXPEDIENTE (RF-TGB-04) ----
                case 'exp:remove': {
                    const asignaturaId = String(payload.data.asignaturaId);
                    const codigo = String(payload.data.codigo ?? '');
                    await core.removeFromExpediente(externalUserId, asignaturaId);
                    await ctx.answerCbQuery(`Quitada ${codigo}`);
                    await sendExpedienteView(ctx, core, callbacks, externalUserId);
                    break;
                }

                case 'exp:add_prompt': {
                    await state.set(chatId, { step: 'EXP:BUSCAR_ASIGNATURA', data: {} }, 900);
                    await ctx.answerCbQuery();
                    await ctx.reply(
                        'Escribe el **nombre o código** de la asignatura que quieres añadir a tu expediente (o /cancelar):',
                        { parse_mode: 'Markdown' },
                    );
                    break;
                }

                case 'exp:subj_page': {
                    const page = Number(payload.data.page ?? 0);
                    const q = String(payload.data.q ?? '');
                    await showExpSubjectSearch(ctx, core, callbacks, q, page);
                    await ctx.answerCbQuery();
                    break;
                }

                case 'exp:subj_add': {
                    const asignaturaId = String(payload.data.asignaturaId);
                    const codigo = String(payload.data.codigo ?? '');
                    await core.addToExpediente(externalUserId, asignaturaId, { updateId });
                    await state.clear(chatId);
                    await ctx.answerCbQuery(`Añadida ${codigo}`);
                    await sendExpedienteView(ctx, core, callbacks, externalUserId);
                    break;
                }

                // ---- Buscar y Ofertar (RF-TGB-05, EP-R-10) ----
                case 'off:subj_select': {
                    const mode = (payload.data.mode as 'search' | 'create') ?? 'search';
                    const asignaturaId = String(payload.data.asignaturaId);
                    const codigo = String(payload.data.codigo ?? '');
                    const nombre = String(payload.data.nombre ?? '');

                    const grupos = await core.listSubjectGroups(externalUserId, asignaturaId);
                    if (grupos.length < 2) {
                        await ctx.answerCbQuery('Sin grupos suficientes');
                        await ctx.reply(`La asignatura **${codigo}** no tiene al menos 2 grupos disponibles para intercambio.`, {
                            parse_mode: 'Markdown',
                        });
                        return;
                    }

                    await state.set(
                        chatId,
                        {
                            step: 'OFERTA:GRUPO_ACTUAL',
                            data: { mode, asignaturaId, codigo, nombre },
                        },
                        900,
                    );

                    const rows = await Promise.all(
                        grupos.map(async (g) => [
                            {
                                text: `Tengo: ${g.nombre}`,
                                callback_data: await callbacks.encode(
                                    {
                                        action: 'off:actual_select',
                                        data: { grupoActualId: g.id, grupoActualNombre: g.nombre },
                                    },
                                    900,
                                ),
                            },
                        ]),
                    );

                    await ctx.answerCbQuery();
                    await ctx.reply(
                        `**${codigo} — ${nombre}\n\n**Selecciona el **grupo que tienes actualmente**:`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: rows },
                        },
                    );
                    break;
                }

                case 'off:actual_select': {
                    const current = await state.get(chatId);
                    const flow = current?.data ?? {};
                    const asignaturaId = String(flow.asignaturaId ?? '');
                    if (!asignaturaId) {
                        await ctx.answerCbQuery('Flujo expirado');
                        await ctx.reply('La operación ha expirado. Vuelve a ejecutar /buscar o /ofertar.');
                        return;
                    }

                    const grupoActualId = String(payload.data.grupoActualId);
                    const grupoActualNombre = String(payload.data.grupoActualNombre ?? '');

                    await state.set(
                        chatId,
                        {
                            step: 'OFERTA:GRUPO_DESEADO',
                            data: { ...flow, grupoActualId, grupoActualNombre },
                        },
                        900,
                    );

                    const grupos = await core.listSubjectGroups(externalUserId, asignaturaId);
                    const candidatos = grupos.filter((g) => g.id !== grupoActualId);

                    const rows = await Promise.all(
                        candidatos.map(async (g) => [
                            {
                                text: `Quiero: ${g.nombre}`,
                                callback_data: await callbacks.encode(
                                    {
                                        action: 'off:deseado_select',
                                        data: { grupoDeseadoId: g.id, grupoDeseadoNombre: g.nombre },
                                    },
                                    900,
                                ),
                            },
                        ]),
                    );

                    await ctx.answerCbQuery();
                    await ctx.reply(
                        `Grupo actual: **${grupoActualNombre}**\n\nSelecciona el **grupo que deseas**:`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: rows },
                        },
                    );
                    break;
                }

                case 'off:deseado_select': {
                    const current = await state.get(chatId);
                    const flow = current?.data ?? {};
                    const mode = (flow.mode as 'search' | 'create') ?? 'search';
                    const asignaturaId = String(flow.asignaturaId ?? '');
                    const codigo = String(flow.codigo ?? '');
                    const nombre = String(flow.nombre ?? '');
                    const grupoActualId = String(flow.grupoActualId ?? '');
                    const grupoActualNombre = String(flow.grupoActualNombre ?? '');
                    const grupoDeseadoId = String(payload.data.grupoDeseadoId);
                    const grupoDeseadoNombre = String(payload.data.grupoDeseadoNombre ?? '');

                    if (!asignaturaId || !grupoActualId) {
                        await ctx.answerCbQuery('Flujo expirado');
                        await ctx.reply('La operación ha expirado. Vuelve a ejecutar /buscar o /ofertar.');
                        return;
                    }

                    if (mode === 'create') {
                        const created = await core.createOffer(
                            externalUserId,
                            { asignaturaId, grupoActualId, grupoDeseadoId },
                            { updateId },
                        );
                        await state.clear(chatId);
                        await ctx.answerCbQuery('Oferta publicada');
                        await ctx.reply(
                            `**Oferta publicada correctamente**\n\n` +
                            `• Asignatura: **${created.asignatura.codigo} — ${created.asignatura.nombre}**\n` +
                            `• Ofreces: **${created.grupoActual.nombre}**\n` +
                            `• Buscas: **${created.grupoDeseado.nombre}**\n` +
                            `• Estado: \`${created.status}\`\n\n` +
                            `Puedes gestionarla en /misofertas.`,
                            { parse_mode: 'Markdown' },
                        );
                        return;
                    }

                    await state.set(
                        chatId,
                        {
                            step: 'OFERTA:RESULTADOS',
                            data: {
                                asignaturaId,
                                codigo,
                                nombre,
                                grupoActualId,
                                grupoActualNombre,
                                grupoDeseadoId,
                                grupoDeseadoNombre,
                            },
                        },
                        900,
                    );

                    await showOfferSearchResults(ctx, core, callbacks, externalUserId, {
                        asignaturaId,
                        codigo,
                        nombre,
                        grupoActualId,
                        grupoActualNombre,
                        grupoDeseadoId,
                        grupoDeseadoNombre,
                    });
                    await ctx.answerCbQuery();
                    break;
                }

                case 'off:search_more': {
                    const current = await state.get(chatId);
                    const flow = current?.data ?? {};
                    const cursor = String(payload.data.cursor ?? '');

                    await showOfferSearchResults(
                        ctx,
                        core,
                        callbacks,
                        externalUserId,
                        {
                            asignaturaId: String(flow.asignaturaId ?? ''),
                            codigo: String(flow.codigo ?? ''),
                            nombre: String(flow.nombre ?? ''),
                            grupoActualId: String(flow.grupoActualId ?? ''),
                            grupoActualNombre: String(flow.grupoActualNombre ?? ''),
                            grupoDeseadoId: String(flow.grupoDeseadoId ?? ''),
                            grupoDeseadoNombre: String(flow.grupoDeseadoNombre ?? ''),
                        },
                        cursor || undefined,
                    );
                    await ctx.answerCbQuery();
                    break;
                }

                case 'off:accept': {
                    const offerId = String(payload.data.offerId);
                    const accepted = await core.acceptOffer(externalUserId, offerId, { updateId });
                    await state.clear(chatId);
                    await ctx.answerCbQuery('Oferta aceptada');
                    await ctx.reply(
                        `**¡Oferta aceptada!**\n\n` +
                        `• Asignatura: **${accepted.asignatura.codigo} — ${accepted.asignatura.nombre}**\n` +
                        `• Cambio: **${accepted.grupoActual.nombre}** ⇄ **${accepted.grupoDeseado.nombre}**\n\n` +
                        `Ya puedes coordinarte con tu compañero/a desde /chat o ver el detalle en /misofertas.`,
                        { parse_mode: 'Markdown' },
                    );
                    break;
                }

                case 'off:publish_from_search': {
                    const current = await state.get(chatId);
                    const flow = current?.data ?? {};
                    const asignaturaId = String(flow.asignaturaId ?? '');
                    const grupoActualId = String(flow.grupoActualId ?? '');
                    const grupoDeseadoId = String(flow.grupoDeseadoId ?? '');

                    if (!asignaturaId || !grupoActualId || !grupoDeseadoId) {
                        await ctx.answerCbQuery('Datos expirados');
                        await ctx.reply('Los datos de búsqueda expiraron. Usa /ofertar para crear la oferta.');
                        return;
                    }

                    const created = await core.createOffer(
                        externalUserId,
                        { asignaturaId, grupoActualId, grupoDeseadoId },
                        { updateId },
                    );
                    await state.clear(chatId);
                    await ctx.answerCbQuery('Oferta publicada');
                    await ctx.reply(
                        `**Oferta publicada con tus parámetros de búsqueda**\n\n` +
                        `• Asignatura: **${created.asignatura.codigo} — ${created.asignatura.nombre}**\n` +
                        `• Ofreces: **${created.grupoActual.nombre}**\n` +
                        `• Buscas: **${created.grupoDeseado.nombre}**\n\n` +
                        `Te avisaremos cuando alguien la acepte. Puedes revisarla en /misofertas.`,
                        { parse_mode: 'Markdown' },
                    );
                    break;
                }

                // ---- Mis ofertas y chat ----
                case 'myoff:close': {
                    const offerId = String(payload.data.offerId ?? '');
                    await core.closeOffer(externalUserId, offerId);
                    await ctx.answerCbQuery('Oferta cerrada');
                    await sendMyOffersView(ctx, core, callbacks, externalUserId);
                    break;
                }

                case 'myoff:chat': {
                    const offerId = String(payload.data.offerId ?? '');
                    await ctx.answerCbQuery('Abriendo chat');
                    await enterOfferChat(ctx, core, state, chatId, externalUserId, offerId);
                    break;
                }

                // ---- Notificaciones ----
                case 'notif:read': {
                    const notificationId = String(payload.data.notificationId ?? '');
                    await core.markNotificationRead(externalUserId, notificationId);
                    await ctx.answerCbQuery('Marcada como leída');
                    await sendNotificationsView(ctx, core, callbacks, externalUserId);
                    break;
                }

                case 'notif:read_all': {
                    await core.markAllNotificationsRead(externalUserId);
                    await ctx.answerCbQuery('Todas leídas');
                    await sendNotificationsView(ctx, core, callbacks, externalUserId);
                    break;
                }

                case 'notif:toggle_enabled': {
                    const prefs = await core.getNotificationPreferences(externalUserId);
                    await core.updateNotificationPreferences(externalUserId, {
                        enabled: !prefs.telegram.enabled,
                    });
                    await ctx.answerCbQuery('Preferencia actualizada');
                    await sendNotificationsView(ctx, core, callbacks, externalUserId);
                    break;
                }

                case 'notif:toggle_chat': {
                    const prefs = await core.getNotificationPreferences(externalUserId);
                    await core.updateNotificationPreferences(externalUserId, {
                        chatMessages: !prefs.telegram.chatMessages,
                    });
                    await ctx.answerCbQuery('Preferencia de chat actualizada');
                    await sendNotificationsView(ctx, core, callbacks, externalUserId);
                    break;
                }

                default:
                    await ctx.answerCbQuery('Acción no reconocida.');
            }
        } catch (error: any) {
            const msg = error?.message || 'Error al procesar la acción.';
            await ctx.answerCbQuery('Error');
            await ctx.reply(`No se pudo completar la acción: ${msg}`);
        }
    });
}

export async function showCarreraPage(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    page: number,
) {
    const carreras = await core.listCareers();
    const totalPages = Math.max(1, Math.ceil(carreras.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = carreras.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const carrera of slice) {
        const cbData = await callbacks.encode(
            {
                action: 'reg:carrera_select',
                data: { carreraId: carrera.id, carreraNombre: carrera.nombre },
            },
            900,
        );
        rows.push([{ text: carrera.nombre, callback_data: cbData }]);
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (safePage > 0) {
        navRow.push({
            text: '<--- Anterior',
            callback_data: await callbacks.encode({ action: 'reg:carrera_page', data: { page: safePage - 1 } }, 900),
        });
    }
    if (safePage < totalPages - 1) {
        navRow.push({
            text: 'Siguiente --->',
            callback_data: await callbacks.encode({ action: 'reg:carrera_page', data: { page: safePage + 1 } }, 900),
        });
    }
    if (navRow.length > 0) rows.push(navRow);

    await ctx.reply(
    `Selecciona tu **carrera** (página ${safePage + 1}/${totalPages}) o escribe /cancelar:`,
    {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
    },
  );
}

export async function showCursoPage(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    carreraId: string,
    page: number,
) {
    const cursos = await core.listCourses(carreraId);
    const totalPages = Math.max(1, Math.ceil(cursos.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = cursos.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const curso of slice) {
        const cbData = await callbacks.encode(
            {
                action: 'reg:curso_select',
                data: { cursoId: curso.id, cursoNombre: curso.nombre },
            },
            900,
        );
        rows.push([{ text: curso.nombre, callback_data: cbData }]);
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (safePage > 0) {
        navRow.push({
            text: '<--- Anterior',
            callback_data: await callbacks.encode(
                { action: 'reg:curso_page', data: { carreraId, page: safePage - 1 } },
                900,
            ),
        });
    }
    if (safePage < totalPages - 1) {
        navRow.push({
            text: 'Siguiente --->',
            callback_data: await callbacks.encode(
                { action: 'reg:curso_page', data: { carreraId, page: safePage + 1 } },
                900,
            ),
        });
    }
    if (navRow.length > 0) rows.push(navRow);

    await ctx.reply(
        `Selecciona tu **curso** (página ${safePage + 1}/${totalPages}) o escribe /cancelar:`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows },
        },
    );
}

export async function showSubjectCandidates(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    params: { q: string; carreraId?: string; cursoId?: string; page: number },
) {
    const offset = params.page * PAGE_SIZE;
    const result = await core.searchSubjects({
        q: params.q,
        carreraId: params.carreraId,
        cursoId: params.cursoId,
        limit: PAGE_SIZE,
        offset,
    });

    if (result.items.length === 0) {
        const fallbackRows: Array<Array<{ text: string; callback_data: string }>> = [];

        if (params.cursoId) {
            fallbackRows.push([
                {
                    text: 'Buscar en toda la carrera',
                    callback_data: await callbacks.encode(
                        { action: 'reg:subj_search_all', data: { q: params.q, page: 0 } },
                        900,
                    ),
                },
            ]);
        }

        fallbackRows.push([
            {
                text: 'Finalizar selección',
                callback_data: await callbacks.encode({ action: 'reg:finish_subjects', data: {} }, 900),
            },
        ]);

        await ctx.reply(
            `No se encontraron asignaturas para \`${params.q || 'tu filtro'}\`. Escribe otro nombre o código, o usa una opción:`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: fallbackRows },
            },
        );
        return;
    }

    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const subj of result.items) {
        const cbData = await callbacks.encode(
            {
                action: 'reg:subj_add',
                data: { asignaturaId: subj.id, codigo: subj.codigo, nombre: subj.nombre },
            },
            900,
        );
        rows.push([{ text: `+ ${subj.codigo} — ${subj.nombre}`, callback_data: cbData }]);
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (params.page > 0) {
        navRow.push({
            text: '<--- Anterior',
            callback_data: await callbacks.encode(
                { action: 'reg:subj_search', data: { q: params.q, page: params.page - 1 } },
                900,
            ),
        });
    }
    if (offset + result.items.length < result.total) {
        navRow.push({
            text: 'Siguiente --->',
            callback_data: await callbacks.encode(
                { action: 'reg:subj_search', data: { q: params.q, page: params.page + 1 } },
                900,
            ),
        });
    }
    if (navRow.length > 0) rows.push(navRow);

    rows.push([
        {
            text: 'Finalizar selección',
            callback_data: await callbacks.encode({ action: 'reg:finish_subjects', data: {} }, 900),
        },
    ]);

    await ctx.reply(
        `Resultados para **${params.q || 'asignaturas'}** (página ${params.page + 1}/${totalPages}):`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows },
        },
    );
}

export async function sendExpedienteView(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    externalUserId: string,
) {
    const items = await core.getExpediente(externalUserId);
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    let text = '**Tu expediente académico**\n\n';
    if (items.length === 0) {
        text += 'No tienes asignaturas registradas todavía.\n';
    } else {
        for (const item of items) {
            const groupsLabel = item.grupos.map((g) => g.nombre).join(', ') || 'Sin grupo';
            text += `• **${item.codigo} — ${item.nombre}** (${item.curso.nombre}) · _${groupsLabel}_\n`;
            rows.push([
                {
                    text: `Quitar ${item.codigo}`,
                    callback_data: await callbacks.encode(
                        { action: 'exp:remove', data: { asignaturaId: item.id, codigo: item.codigo } },
                        900,
                    ),
                },
            ]);
        }
    }

    rows.push([
        {
            text: '+ Añadir asignatura',
            callback_data: await callbacks.encode({ action: 'exp:add_prompt', data: {} }, 900),
        },
    ]);

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
    });
}

export async function showExpSubjectSearch(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    q: string,
    page: number,
) {
    const offset = page * PAGE_SIZE;
    const result = await core.searchSubjects({ q, limit: PAGE_SIZE, offset });

    if (result.items.length === 0) {
        await ctx.reply(
            `No se encontraron asignaturas para \`${q}\`. Escribe otro nombre o código (o /cancelar):`,
            { parse_mode: 'Markdown' },
        );
        return;
    }

    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const subj of result.items) {
        rows.push([
            {
                text: `+ ${subj.codigo} — ${subj.nombre}`,
                callback_data: await callbacks.encode(
                    { action: 'exp:subj_add', data: { asignaturaId: subj.id, codigo: subj.codigo } },
                    900,
                ),
            },
        ]);
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) {
        navRow.push({
            text: '<--- Anterior',
            callback_data: await callbacks.encode({ action: 'exp:subj_page', data: { q, page: page - 1 } }, 900),
        });
    }
    if (offset + result.items.length < result.total) {
        navRow.push({
            text: 'Siguiente --->',
            callback_data: await callbacks.encode({ action: 'exp:subj_page', data: { q, page: page + 1 } }, 900),
        });
    }
    if (navRow.length > 0) rows.push(navRow);

    await ctx.reply(
        `Resultados para **${q}** (página ${page + 1}/${totalPages}):`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows },
        },
    );
}

export async function startOfferFlow(
    ctx: TelegramContext,
    core: BackServices['core'],
    state: BackServices['state'],
    callbacks: BackServices['callbacks'],
    chatId: string,
    externalUserId: string,
    mode: 'search' | 'create',
) {
    const expediente = await core.getExpediente(externalUserId);
    if (expediente.length === 0) {
        await ctx.reply(
            'Tu expediente está vacío. Usa /expediente para añadir al menos una asignatura antes de buscar o publicar ofertas.',
        );
        return;
    }

    await state.set(chatId, { step: 'OFERTA:ELEGIR_ASIGNATURA', data: { mode } }, 900);

    const rows = await Promise.all(
        expediente.map(async (item) => [
            {
                text: `${item.codigo} — ${item.nombre}`,
                callback_data: await callbacks.encode(
                    {
                        action: 'off:subj_select',
                        data: {
                            mode,
                            asignaturaId: item.id,
                            codigo: item.codigo,
                            nombre: item.nombre,
                        },
                    },
                    900,
                ),
            },
        ]),
    );

    const titulo = mode === 'search' ? 'Buscar ofertas complementarias' : 'Publicar oferta de cambio';
    await ctx.reply(
        `**${titulo}**\n\nElige una **asignatura de tu expediente** (o /cancelar):`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows },
        },
    );
}

async function showOfferSearchResults(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    externalUserId: string,
    params: {
        asignaturaId: string;
        codigo: string;
        nombre: string;
        grupoActualId: string;
        grupoActualNombre: string;
        grupoDeseadoId: string;
        grupoDeseadoNombre: string;
    },
    cursor?: string,
) {
    const page = await core.searchOffers(externalUserId, {
        asignaturaId: params.asignaturaId,
        grupoActualId: params.grupoActualId,
        grupoDeseadoId: params.grupoDeseadoId,
        limit: PAGE_SIZE,
        cursor,
    });

    if (page.items.length === 0) {
        await ctx.reply(
            `No hay ofertas complementarias para **${params.codigo}** (${params.grupoActualNombre} → ${params.grupoDeseadoNombre}).\n\n` +
            '¿Quieres publicar una oferta con estos mismos parámetros para que otro estudiante pueda aceptarla?',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: 'Publicar oferta',
                            callback_data: await callbacks.encode({ action: 'off:publish_from_search', data: {} }, 900),
                        },
                    ]],
                },
            },
        );
        return;
    }

    let text = `**Ofertas disponibles para ${params.codigo} — ${params.nombre}**\n` +
        `Tu cambio: **${params.grupoActualNombre}** → **${params.grupoDeseadoNombre}**\n\n`;

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const offer of page.items) {
        text += `• **${offer.creator.name}** ofrece **${offer.grupoActual.nombre}** a cambio de **${offer.grupoDeseado.nombre}**\n`;
        rows.push([
            {
                text: `Apuntarme (con ${offer.creator.name})`,
                callback_data: await callbacks.encode(
                    { action: 'off:accept', data: { offerId: offer.id } },
                    900,
                ),
            },
        ]);
    }

    if (page.nextCursor) {
        rows.push([
            {
                text: 'Ver más resultados --->',
                callback_data: await callbacks.encode(
                    { action: 'off:search_more', data: { cursor: page.nextCursor } },
                    900,
                ),
            },
        ]);
    }

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
    });
}

export async function sendMyOffersView(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    externalUserId: string,
) {
    const res = await core.listMyOffers(externalUserId);
    if (res.items.length === 0) {
        await ctx.reply('No tienes ofertas creadas ni aceptadas todavía. Usa /buscar o /ofertar para empezar.');
        return;
    }

    let text = '**Tus ofertas**\n\n';
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    for (const offer of res.items) {
        const rolLabel = offer.isCreator ? 'Creada' : 'Aceptada';
        text +=
            `• **${offer.asignatura.codigo} — ${offer.asignatura.nombre}** ` +
            `(**${offer.grupoActual.nombre}** → **${offer.grupoDeseado.nombre}**) · ` +
            `Estado: \`${offer.status}\` (${rolLabel})\n`;

        const actionRow: Array<{ text: string; callback_data: string }> = [];
        if (offer.status === 'ACCEPTED') {
            actionRow.push({
                text: `Abrir chat (${offer.asignatura.codigo})`,
                callback_data: await callbacks.encode({ action: 'myoff:chat', data: { offerId: offer.id } }, 900),
            });
        }
        if (offer.status !== 'CLOSED') {
            actionRow.push({
                text: `Cerrar (${offer.asignatura.codigo})`,
                callback_data: await callbacks.encode({ action: 'myoff:close', data: { offerId: offer.id } }, 900),
            });
        }
        if (actionRow.length > 0) rows.push(actionRow);
    }

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: rows.length > 0 ? { inline_keyboard: rows } : undefined,
    });
}

export async function enterOfferChat(
    ctx: TelegramContext,
    core: BackServices['core'],
    state: BackServices['state'],
    chatId: string,
    externalUserId: string,
    offerId: string,
) {
    const history = await core.getOfferMessages(externalUserId, offerId);
    await state.set(chatId, { step: 'CHAT:ACTIVO', data: { offerId } }, 3600);

    let text = `**Chat de oferta (\`${offerId}\`)**\n`;
    text += history.chatOpen
        ? 'Escribe cualquier mensaje para enviarlo. Usa /salir para terminar.\n\n'
        : 'Este chat está cerrado en este momento. Usa /salir para volver.\n\n';

    if (history.items.length === 0) {
        text += '_No hay mensajes previos en este intercambio._';
    } else {
        for (const m of history.items.slice(-8)) {
            const autor = m.isMine ? 'Tú' : m.authorName;
            text += `• **${autor}**: ${m.content}\n`;
        }
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function sendNotificationsView(
    ctx: TelegramContext,
    core: BackServices['core'],
    callbacks: BackServices['callbacks'],
    externalUserId: string,
) {
    const [page, prefs] = await Promise.all([
        core.getNotifications(externalUserId),
        core.getNotificationPreferences(externalUserId),
    ]);

    let text = '**Notificaciones**\n\n';
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    if (page.items.length === 0) {
        text += 'No tienes notificaciones.\n';
    } else {
        for (const n of page.items.slice(0, 8)) {
            const marca = n.isRead ? 'Leída' : 'No leída';
            text += `• **[${marca}] ${n.asunto}**\n  ${n.contenido}\n`;
            if (!n.isRead) {
                rows.push([
                    {
                        text: `Marcar leída: ${n.asunto.slice(0, 24)}`,
                        callback_data: await callbacks.encode(
                            { action: 'notif:read', data: { notificationId: n.id } },
                            900,
                        ),
                    },
                ]);
            }
        }
        if (page.items.some((n) => !n.isRead)) {
            rows.push([
                {
                    text: 'Marcar todas como leídas',
                    callback_data: await callbacks.encode({ action: 'notif:read_all', data: {} }, 900),
                },
            ]);
        }
    }

    text +=
        '\n**Preferencias Telegram:**\n' +
        `• Avisos activos: **${prefs.telegram.enabled ? 'Sí' : 'No'}**\n` +
        `• Mensajes de chat: **${prefs.telegram.chatMessages ? 'Sí' : 'No'}**`;

    rows.push([
        {
            text: `Avisos: ${prefs.telegram.enabled ? 'Desactivar' : 'Activar'}`,
            callback_data: await callbacks.encode({ action: 'notif:toggle_enabled', data: {} }, 900),
        },
        {
            text: `Chat: ${prefs.telegram.chatMessages ? 'Desactivar' : 'Activar'}`,
            callback_data: await callbacks.encode({ action: 'notif:toggle_chat', data: {} }, 900),
        },
    ]);

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
    });
}