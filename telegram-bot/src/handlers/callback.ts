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