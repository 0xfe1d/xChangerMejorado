import assert from 'node:assert/strict';
import { normalizeCoreApiUrl } from '../src/back/config/env';
import { OutboundQueue } from '../src/back/telegram/outbound-queue';
import { registerCallbackHandlers, sendMyOffersView } from '../src/handlers/callback';
import { registerCommands } from '../src/handlers/command';
import { createEventHandlers } from '../src/handlers/events';
import { registerTextHandler } from '../src/handlers/text';
import { markdownLikeToSafeHtml } from '../src/index';

function createHandlerHarness(initialLinked = false) {
  const middlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
  const commands = new Map<string, (ctx: any) => Promise<void>>();
  const textHandlers: Array<(ctx: any) => Promise<void>> = [];

  const bot = {
    use: (fn: any) => middlewares.push(fn),
    command: (name: string, fn: any) => commands.set(name, fn),
    on: (event: string, fn: any) => {
      if (event === 'text') textHandlers.push(fn);
    },
  };

  const stateStore = new Map<string, { step: string; data: Record<string, unknown> }>();
  const state: any = {
    get: async (chatId: string) => stateStore.get(chatId) ?? null,
    set: async (chatId: string, value: any) => {
      stateStore.set(chatId, value);
    },
    clear: async (chatId: string) => {
      stateStore.delete(chatId);
    },
  };

  let linked = initialLinked;
  const core: any = {
    isLinked: async () => linked,
    createLinkRequest: async () => ({
      deviceCode: 'dev_123',
      userCode: 'ABCD-1234',
      verificationUriComplete: 'http://localhost:4321/vincular?code=ABCD-1234',
    }),
    sendEmailOtp: async () => ({
      challengeToken: 'chal_1',
      codeLength: 6,
      expiresIn: 300,
    }),
    verifyEmailOtp: async () => ({
      kind: 'session',
      user: { id: 'u1', name: 'Oscar' },
    }),
    verifyRegistrationOtp: async () => ({
      user: { id: 'u1', name: 'Oscar' },
    }),
    getProfile: async () => ({
      name: 'Oscar',
      email: 'oscar@alumnos.unican.es',
      role: 'STUDENT',
      mfa: { enabled: false },
    }),
    revoke: async () => {
      linked = false;
    },
    listMyOffers: async () => ({ items: [] }),
    sendOfferMessage: async () => ({}),
  };

  const callbacks: any = {
    encode: async () => 'cb:mock',
  };

  const services: any = { core, state, callbacks };
  registerCommands(bot, services);
  registerTextHandler(bot, services);

  function makeCtx(opts: { text?: string; chatType?: 'private' | 'group'; messageId?: number } = {}) {
    const replies: string[] = [];
    const deleted: number[] = [];
    const ctx: any = {
      chat: { id: 1001, type: opts.chatType ?? 'private' },
      from: { id: 2002, first_name: 'Oscar' },
      message: opts.text !== undefined ? { text: opts.text, message_id: opts.messageId ?? 10 } : undefined,
      update: { update_id: 1 },
      reply: async (msg: string) => {
        replies.push(msg);
      },
      deleteMessage: async (msgId: number) => {
        deleted.push(msgId);
      },
    };
    return { ctx, replies, deleted };
  }

  async function runCommand(cmd: string, ctx: any) {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(ctx, async () => {
        nextCalled = true;
      });
      if (!nextCalled) return;
    }
    const handler = commands.get(cmd);
    if (handler) await handler(ctx);
  }

  async function runText(ctx: any) {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(ctx, async () => {
        nextCalled = true;
      });
      if (!nextCalled) return;
    }
    for (const handler of textHandlers) {
      await handler(ctx);
    }
  }

  return { stateStore, core, makeCtx, runCommand, runText };
}

describe('Handlers del bot - Guardias, estados y validaciones', () => {
  it('bloquea chats no privados (RF-TGB-12)', async () => {
    const { makeCtx, runCommand } = createHandlerHarness();
    const { ctx, replies } = makeCtx({ text: '/start', chatType: 'group' });

    await runCommand('start', ctx);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /chats privados/i);
  });

  it('limpia el estado previo al ejecutar otro comando nuevo', async () => {
    const { stateStore, makeCtx, runCommand } = createHandlerHarness();
    stateStore.set('1001', { step: 'REGISTRO:ESPERANDO_EMAIL', data: { name: 'Oscar' } });

    const { ctx } = makeCtx({ text: '/ayuda' });
    await runCommand('ayuda', ctx);

    assert.equal(stateStore.has('1001'), false);
  });

  it('mantiene CHAT:ACTIVO hasta que /salir lo limpia', async () => {
    const { stateStore, makeCtx, runCommand } = createHandlerHarness(true);
    stateStore.set('1001', { step: 'CHAT:ACTIVO', data: { offerId: 'offer_1' } });

    const { ctx, replies } = makeCtx({ text: '/salir' });
    await runCommand('salir', ctx);

    assert.equal(stateStore.has('1001'), false);
    assert.match(replies[0], /salido del modo chat/i);
  });

  it('rechaza email sin @ en ENTRAR:ESPERANDO_EMAIL sin cambiar de paso', async () => {
    const { stateStore, makeCtx, runCommand, runText } = createHandlerHarness();

    await runCommand('entrar', makeCtx({ text: '/entrar' }).ctx);
    assert.equal(stateStore.get('1001')?.step, 'ENTRAR:ESPERANDO_EMAIL');

    const bad = makeCtx({ text: 'correo-sin-arroba' });
    await runText(bad.ctx);

    assert.equal(stateStore.get('1001')?.step, 'ENTRAR:ESPERANDO_EMAIL');
    assert.match(bad.replies[0], /no es válido/i);
  });

  it('elimina el mensaje con código OTP al iniciar sesión (RF-TGB-13)', async () => {
    const { stateStore, makeCtx, runText } = createHandlerHarness();
    stateStore.set('1001', {
      step: 'ENTRAR:ESPERANDO_OTP',
      data: { challengeToken: 'chal_1', email: 'oscar@alumnos.unican.es' },
    });

    const { ctx, deleted, replies } = makeCtx({ text: '123456', messageId: 99 });
    await runText(ctx);

    assert.deepEqual(deleted, [99]);
    assert.equal(stateStore.has('1001'), false);
    assert.match(replies[0], /Inicio de sesión exitoso/i);
  });

  it('/vincular oculta deviceCode y bloquea si ya está vinculado', async () => {
    const anon = createHandlerHarness(false);
    const { ctx: c1, replies: r1 } = anon.makeCtx({ text: '/vincular' });
    await anon.runCommand('vincular', c1);
    assert.match(r1[0], /ABCD-1234/);
    assert.equal(r1[0].includes('dev_123'), false);

    const linked = createHandlerHarness(true);
    const { ctx: c2, replies: r2 } = linked.makeCtx({ text: '/vincular' });
    await linked.runCommand('vincular', c2);
    assert.match(r2[0], /Ya tienes una cuenta vinculada/i);
  });

  it('/perfil detecta mfaEnabled del Core real', async () => {
    const { core, makeCtx, runCommand } = createHandlerHarness(true);
    core.getProfile = async () => ({
      id: 'u1',
      name: 'Oscar',
      email: 'oscar@alumnos.unican.es',
      role: 'ESTUDIANTE',
      mfaEnabled: true,
    });

    const { ctx, replies } = makeCtx({ text: '/perfil' });
    await runCommand('perfil', ctx);
    assert.match(replies[0], /MFA: Activado/);
    assert.match(replies[0], /Rol: Estudiante/);
  });

  it('markdownLikeToSafeHtml convierte negrita/código/cursiva sin romper guiones bajos', () => {
    const html = markdownLikeToSafeHtml(
      '**Perfil** de `code_123_abc` para juan_perez@alumnos.unican.es · _Sin mensajes previos_',
    );
    assert.equal(
      html,
      '<b>Perfil</b> de <code>code_123_abc</code> para juan_perez@alumnos.unican.es · <i>Sin mensajes previos</i>',
    );
  });

  it('createEventHandlers evita duplicar CHAT_MESSAGE y entrega avisos de otros usuarios', async () => {
    const sent: Array<{ chatId: string | number; text: string }> = [];
    const outbound = {
      sendMessage: jest.fn(async (chatId: string | number, text: string) => {
        sent.push({ chatId, text });
      }),
    } as unknown as OutboundQueue;

    const handlers = createEventHandlers(outbound);
    await handlers.onNotificationCreated('chat-1', {
      notificationId: 'n1',
      userId: 'u1',
      asunto: 'Nuevo mensaje',
      contenido: 'Vista previa',
      kind: 'CHAT_MESSAGE',
      refs: { offerId: 'off1' },
    });
    assert.equal(sent.length, 0);

    await handlers.onNotificationCreated('chat-1', {
      notificationId: 'n2',
      userId: 'u1',
      asunto: 'Oferta aceptada',
      contenido: 'Ana aceptó tu oferta',
      kind: 'OFFER_ACCEPTED',
      refs: { offerId: 'off1' },
    });
    assert.equal(sent.length, 1);

    await handlers.onOfferMessageCreated('chat-1', 'u1', {
      offerId: 'off1',
      messageId: 'm1',
      authorId: 'u2',
      authorName: 'Ana',
      content: 'Hola',
      timestamp: new Date().toISOString(),
    });
    assert.equal(sent.length, 2);
  });

  it('evita duplicar ofertas OPEN idénticas y muestra estados amigables en /misofertas', async () => {
    const callbacksMap = new Map<string, { action: string; data: Record<string, unknown> }>();
    const callbackHandlers: Array<(ctx: any) => Promise<void>> = [];
    const bot = {
      use: () => undefined,
      command: () => undefined,
      on: (event: string, fn: (ctx: any) => Promise<void>) => {
        if (event === 'callback_query') callbackHandlers.push(fn);
      },
    };

    const existingOffer = {
      id: 'off_1',
      createdAt: new Date().toISOString(),
      status: 'OPEN' as const,
      asignatura: { id: 'asig_1', codigo: 'GII-101', nombre: 'Programación I' },
      grupoActual: { id: 'grp_a', nombre: 'Grupo A (Mañana)' },
      grupoDeseado: { id: 'grp_b', nombre: 'Grupo B (Tarde)' },
      isCreator: true,
      counterpart: null,
    };

    let createCalls = 0;
    let listMyOffersCalls = 0;
    const core: any = {
      listMyOffers: async () => {
        listMyOffersCalls += 1;
        return { items: [existingOffer], nextCursor: null };
      },
      createOffer: async () => {
        createCalls += 1;
        return existingOffer;
      },
    };

    const stateStore = new Map<string, { step: string; data: Record<string, unknown> }>([
      [
        '1001',
        {
          step: 'OFERTA:GRUPO_DESEADO',
          data: {
            mode: 'create',
            asignaturaId: 'asig_1',
            codigo: 'GII-101',
            nombre: 'Programación I',
            grupoActualId: 'grp_a',
            grupoActualNombre: 'Grupo A (Mañana)',
          },
        },
      ],
    ]);
    const state: any = {
      get: async (id: string) => stateStore.get(id) ?? null,
      set: async (id: string, val: any) => stateStore.set(id, val),
      clear: async (id: string) => stateStore.delete(id),
    };
    const callbacks: any = {
      encode: async (payload: { action: string; data: Record<string, unknown> }) => {
        const key = `cb:${callbacksMap.size + 1}`;
        callbacksMap.set(key, payload);
        return key;
      },
      decode: async (key: string) => callbacksMap.get(key) ?? null,
    };

    registerCallbackHandlers(bot, { core, state, callbacks } as any);
    const key = await callbacks.encode({
      action: 'off:deseado_select',
      data: { grupoDeseadoId: 'grp_b', grupoDeseadoNombre: 'Grupo B (Tarde)' },
    });

    const replies: string[] = [];
    const cbAnswers: string[] = [];
    let keyboardUsed = false;
    await callbackHandlers[0]({
      chat: { id: 1001, type: 'private' },
      from: { id: 2002, first_name: 'Oscar' },
      callbackQuery: { id: 'q1', data: key },
      answerCbQuery: async (msg?: string) => cbAnswers.push(msg ?? ''),
      editMessageReplyMarkup: async () => {
        if (keyboardUsed) throw new Error('400: Bad Request: message is not modified');
        keyboardUsed = true;
      },
      reply: async (msg: string) => replies.push(msg),
    });
    await callbackHandlers[0]({
      chat: { id: 1001, type: 'private' },
      from: { id: 2002, first_name: 'Oscar' },
      callbackQuery: { id: 'q2', data: key },
      answerCbQuery: async (msg?: string) => cbAnswers.push(msg ?? ''),
      editMessageReplyMarkup: async () => {
        if (keyboardUsed) throw new Error('400: Bad Request: message is not modified');
        keyboardUsed = true;
      },
      reply: async (msg: string) => replies.push(msg),
    });

    assert.equal(createCalls, 0);
    assert.equal(listMyOffersCalls, 1);
    assert.match(cbAnswers[1], /menú ya se actualizó/i);
    assert.match(cbAnswers[0], /Ya tienes esa oferta abierta/i);
    assert.match(replies[0], /Ya tienes una oferta abierta con esos mismos grupos/i);

    const viewReplies: string[] = [];
    await sendMyOffersView(
      {
        chat: { id: 1001, type: 'private' },
        from: { id: 2002, first_name: 'Oscar' },
        updateType: 'message',
        reply: async (msg: string) => viewReplies.push(msg),
        deleteMessage: async () => true,
        answerCbQuery: async () => true,
        editMessageReplyMarkup: async () => true,
      },
      core,
      callbacks,
      '2002',
    );
    assert.match(viewReplies[0], /Abierta/);
    assert.match(viewReplies[0], /Publicada por ti/);
    assert.equal(viewReplies[0].includes('OPEN'), false);
  });

  it('responde ante comandos desconocidos sugiriendo /ayuda', async () => {
    const { makeCtx, runText } = createHandlerHarness();
    const { ctx, replies } = makeCtx({ text: '/inventado' });
    await runText(ctx);

    assert.equal(replies.length, 1);
    assert.match(replies[0], /Comando no reconocido/i);
    assert.match(replies[0], /\/ayuda/);
  });

  it('solo confirma /cancelar cuando hay una operación activa', async () => {
    const emptyHarness = createHandlerHarness();
    const emptyCtx = emptyHarness.makeCtx({ text: '/cancelar' });
    await emptyHarness.runCommand('cancelar', emptyCtx.ctx);
    assert.deepEqual(emptyCtx.replies, ['No hay ninguna operación en curso.']);

    const activeHarness = createHandlerHarness();
    activeHarness.stateStore.set('1001', { step: 'ENTRAR:ESPERANDO_EMAIL', data: {} });
    const activeCtx = activeHarness.makeCtx({ text: '/cancelar' });
    await activeHarness.runCommand('cancelar', activeCtx.ctx);
    assert.deepEqual(activeCtx.replies, ['Solicitud cancelada.']);
    assert.equal(activeHarness.stateStore.has('1001'), false);
  });

  it('responde cuando el usuario escribe texto en pasos que requieren pulsar botón', async () => {
    const { stateStore, makeCtx, runText } = createHandlerHarness();
    stateStore.set('1001', { step: 'REGISTRO:ELEGIR_CARRERA', data: { name: 'Oscar' } });

    const { ctx, replies } = makeCtx({ text: '1' });
    await runText(ctx);

    assert.equal(replies.length, 1);
    assert.match(replies[0], /pulsa uno de los botones/i);
    assert.match(replies[0], /\/cancelar/);
  });

  it('muestra la contraparte en /misofertas cuando la oferta está aceptada', async () => {
    const acceptedOffer = {
      id: 'off_acc',
      createdAt: new Date().toISOString(),
      status: 'ACCEPTED' as const,
      asignatura: { id: 'asig_1', codigo: 'GII-101', nombre: 'Programación I' },
      grupoActual: { id: 'grp_a', nombre: 'Grupo A' },
      grupoDeseado: { id: 'grp_b', nombre: 'Grupo B' },
      isCreator: true,
      counterpart: { name: 'Ana García' },
    };
    const core: any = {
      listMyOffers: async () => ({ items: [acceptedOffer], nextCursor: null }),
    };
    const callbacks: any = { encode: async () => 'cb:1' };
    const viewReplies: string[] = [];

    await sendMyOffersView(
      {
        chat: { id: 1001, type: 'private' },
        from: { id: 2002, first_name: 'Oscar' },
        updateType: 'message',
        reply: async (msg: string) => viewReplies.push(msg),
        deleteMessage: async () => true,
        answerCbQuery: async () => true,
        editMessageReplyMarkup: async () => true,
      },
      core,
      callbacks,
      '2002',
    );

    assert.match(viewReplies[0], /con \*\*Ana García\*\*/);
  });

  it('bloquea pulsar botones de pasos anteriores cuando el flujo ya avanzó', async () => {
    const callbacksMap = new Map<string, { action: string; data: Record<string, unknown> }>();
    const callbackHandlers: Array<(ctx: any) => Promise<void>> = [];
    const bot = {
      use: () => undefined,
      command: () => undefined,
      on: (event: string, fn: (ctx: any) => Promise<void>) => {
        if (event === 'callback_query') callbackHandlers.push(fn);
      },
    };

    let listGroupsCalled = 0;
    const core: any = {
      listSubjectGroups: async () => {
        listGroupsCalled += 1;
        return [];
      },
    };
    const stateStore = new Map<string, { step: string; data: Record<string, unknown> }>([
      ['1001', { step: 'OFERTA:GRUPO_DESEADO', data: { asignaturaId: 'asig_1', grupoActualId: 'grp_a' } }],
    ]);
    const state: any = {
      get: async (id: string) => stateStore.get(id) ?? null,
      set: async (id: string, val: any) => stateStore.set(id, val),
      clear: async (id: string) => stateStore.delete(id),
    };
    const callbacks: any = {
      encode: async (payload: { action: string; data: Record<string, unknown> }) => {
        const key = `cb:${callbacksMap.size + 1}`;
        callbacksMap.set(key, payload);
        return key;
      },
      decode: async (key: string) => callbacksMap.get(key) ?? null,
    };

    registerCallbackHandlers(bot, { core, state, callbacks } as any);
    const staleKey = await callbacks.encode({
      action: 'off:actual_select',
      data: { grupoActualId: 'grp_b', grupoActualNombre: 'Grupo B' },
    });

    const replies: string[] = [];
    const cbAnswers: string[] = [];
    await callbackHandlers[0]({
      chat: { id: 1001, type: 'private' },
      from: { id: 2002, first_name: 'Oscar' },
      callbackQuery: { id: 'q_stale', data: staleKey },
      answerCbQuery: async (msg?: string) => cbAnswers.push(msg ?? ''),
      editMessageReplyMarkup: async () => true,
      reply: async (msg: string) => replies.push(msg),
    });

    assert.equal(listGroupsCalled, 0);
    assert.equal(stateStore.get('1001')?.step, 'OFERTA:GRUPO_DESEADO');
    assert.match(cbAnswers[0], /Paso ya completado/i);
    assert.match(replies[0], /Continúa con el paso actual/i);
  });

  it('normaliza CORE_API_URL tanto si se pasa el dominio raíz como si incluye /api/v1', () => {
    assert.equal(normalizeCoreApiUrl('https://xchanger-uc.xyz'), 'https://xchanger-uc.xyz/api/v1');
    assert.equal(normalizeCoreApiUrl('https://xchanger-uc.xyz/'), 'https://xchanger-uc.xyz/api/v1');
    assert.equal(normalizeCoreApiUrl('https://xchanger-uc.xyz/api/v1'), 'https://xchanger-uc.xyz/api/v1');
    assert.equal(normalizeCoreApiUrl('https://xchanger-uc.xyz/api/v1/'), 'https://xchanger-uc.xyz/api/v1');
    assert.equal(normalizeCoreApiUrl('http://backend:3000/api/v1'), 'http://backend:3000/api/v1');
  });
});