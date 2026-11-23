import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerCommands } from '../src/handlers/command';
import { registerTextHandler } from '../src/handlers/text';

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

  return { stateStore, makeCtx, runCommand, runText };
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
});