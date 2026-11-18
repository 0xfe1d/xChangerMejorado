import crypto from 'crypto';
import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { PassThrough } from 'stream';
import { Queryable } from '../src/back/config/db';
import { RedisCatalogCache } from '../src/back/core/catalog-cache';
import { HttpCoreClient } from '../src/back/core/http-core.client';
import { ServiceAuthManager } from '../src/back/core/service-auth';
import {
  ChannelSessionManager,
  CoreIssuedSessionPayload,
} from '../src/back/core/session-manager';
import { TokenCipher } from '../src/back/crypto/token-cipher';
import {
  RedisEventStreamConsumer,
  RedisStreamClient,
  StreamEntry,
} from '../src/back/events/event-consumer';
import { BotEventDispatcher, CoreEventEnvelope } from '../src/back/events/event-dispatcher';
import { BotHttpServer, TelegramUpdate } from '../src/back/http/webhook-server';
import { TelegramAccountsRepository } from '../src/back/storage/accounts.repo';
import {
  RedisDedupStore,
  RedisLike,
  RedisPendingLinkStore,
} from '../src/back/storage/redis-stores';
import { OutboundQueue } from '../src/back/telegram/outbound-queue';
import { BotEventHandlers } from '../src/contracts';

class IntegrationRedis implements RedisLike, RedisStreamClient {
  readonly kv = new Map<string, string>();
  private readonly stream: Array<{ id: string; fields: string[] }> = [];
  private readonly pending = new Map<string, string[]>();
  private deliveredIndex = 0;
  private seq = 0;

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _secondsToken: 'EX',
    _seconds: number,
    nxToken?: 'NX',
  ): Promise<string | null> {
    if (nxToken === 'NX' && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) removed += 1;
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.kv.has(k)).length;
  }

  publishEvent(event: CoreEventEnvelope): void {
    this.seq += 1;
    this.stream.push({ id: `${this.seq}-0`, fields: ['event', JSON.stringify(event)] });
  }

  async xgroup(): Promise<unknown> {
    return 'OK';
  }

  async xreadgroup(...args: Array<string | number>): Promise<unknown> {
    const streamName = String(args[args.length - 2]);
    if (this.deliveredIndex >= this.stream.length) return null;
    const batch = this.stream.slice(this.deliveredIndex);
    this.deliveredIndex = this.stream.length;
    const entries: StreamEntry[] = batch.map((e) => {
      this.pending.set(e.id, e.fields);
      return [e.id, e.fields];
    });
    return [[streamName, entries]];
  }

  async xautoclaim(): Promise<unknown> {
    return ['0-0', [...this.pending.entries()]];
  }

  async xack(_stream: string, _group: string, id: string): Promise<number> {
    return this.pending.delete(id) ? 1 : 0;
  }
}

interface AccountDbRow {
  telegram_user_id: string;
  chat_id: string;
  core_user_id: string;
  channel_session_id: string;
  refresh_token_enc: string;
  locale: string;
  linked_at: Date;
}

class IntegrationBotDb implements Queryable {
  readonly rows = new Map<string, AccountDbRow>();

  async query<T>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const sql = text.trim();

    if (sql.startsWith('INSERT INTO telegram_accounts')) {
      const [tgId, chatId, coreId, sessionId, encToken, locale] = params as string[];
      this.rows.set(tgId, {
        telegram_user_id: tgId,
        chat_id: chatId,
        core_user_id: coreId,
        channel_session_id: sessionId,
        refresh_token_enc: encToken,
        locale,
        linked_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('WHERE telegram_user_id = $1') && sql.startsWith('SELECT')) {
      const row = this.rows.get(params[0] as string);
      return { rows: (row ? [row] : []) as unknown as T[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('WHERE core_user_id = ANY($1::text[])')) {
      const ids = new Set(params[0] as string[]);
      const found = [...this.rows.values()].filter((r) => ids.has(r.core_user_id));
      return { rows: found as unknown as T[], rowCount: found.length };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE core_user_id = $1')) {
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.core_user_id === params[0]) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE channel_session_id = $1')) {
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.channel_session_id === params[0]) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`SQL no soportado: ${sql}`);
  }
}

async function sendWebhook(
  server: BotHttpServer,
  secret: string,
  update: TelegramUpdate,
): Promise<{ status: number; json: unknown }> {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = 'POST';
  req.url = '/telegram/webhook';
  req.headers = {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': secret,
  };

  let status = 200;
  let body = '';
  const res = {
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) body += chunk.toString();
      res.writableEnded = true;
      return res;
    },
  };

  const pending = server.handleRequest(req, res as unknown as ServerResponse);
  req.write(JSON.stringify(update));
  req.end();
  await pending;

  return { status, json: body ? JSON.parse(body) : undefined };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createE2EStack() {
  const redis = new IntegrationRedis();
  const db = new IntegrationBotDb();
  const cipher = new TokenCipher(crypto.randomBytes(32).toString('base64'));
  const accountsRepo = new TelegramAccountsRepository(db, cipher);
  const pendingLinkStore = new RedisPendingLinkStore(redis);
  const dedupStore = new RedisDedupStore(redis);
  const catalogCache = new RedisCatalogCache(redis);

  const sentToTelegram: Array<{ chat_id: string; text: string }> = [];
  const offersCreated: Array<{ id: string; asignaturaId: string; idempotencyKey: string }> = [];
  const idemCache = new Map<string, { id: string; status: string }>();
  let blockedUser = false;

  const coreFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/service-auth/token')) {
      return json({
        access_token: 'svc_e2e_jwt',
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'channel:telegram',
      });
    }

    if (headers['X-Service-Authorization'] !== 'Bearer svc_e2e_jwt') {
      return json({ error: 'Servicio no autorizado', code: 'SERVICE_UNAUTHORIZED' }, 401);
    }

    if (url.endsWith('/channel-auth/link-requests')) {
      return json(
        {
          deviceCode: 'dev_e2e_123',
          userCode: 'E2E1-2345',
          verificationUri: 'https://xchanger.test/vincular',
          verificationUriComplete: 'https://xchanger.test/vincular?code=E2E1-2345',
          expiresIn: 600,
          interval: 5,
        },
        201,
      );
    }

    if (url.endsWith('/channel-auth/email-otp')) {
      return json({ challengeToken: 'ch_email_mfa', expiresIn: 600, codeLength: 6 }, 202);
    }

    if (url.endsWith('/channel-auth/token')) {
      if (body.grant_type === 'email_otp') {
        return json({
          mfaRequired: true,
          challengeToken: 'ch_mfa_step2',
          expiresIn: 300,
          methods: ['xotp', 'recovery_code'],
        });
      }
      const issued: CoreIssuedSessionPayload = {
        accessToken: `acc_${body.grant_type}`,
        accessTokenExpiresIn: 900,
        refreshToken: `ref_${body.grant_type}`,
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_e2e_1', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_ana',
          name: 'Ana Pérez',
          role: 'ESTUDIANTE',
          mfaEnabled: body.grant_type === 'mfa',
          hasExpediente: true,
        },
      };
      return json(issued);
    }

    // Rutas S+U
    if (!headers['Authorization']?.startsWith('Bearer acc_')) {
      return json({ error: 'No autenticado', code: 'UNAUTHORIZED' }, 401);
    }
    if (blockedUser) {
      return json({ error: 'Cuenta bloqueada', code: 'ACCOUNT_BLOCKED' }, 403);
    }

    if (url.includes('/offers/me')) {
      return json({
        items: offersCreated.map((o) => ({
          id: o.id,
          createdAt: '2026-11-18T12:00:00Z',
          status: 'OPEN',
          asignatura: { id: o.asignaturaId, codigo: 'G1234', nombre: 'DAW' },
          grupoActual: { id: 'g1', nombre: 'PL1' },
          grupoDeseado: { id: 'g2', nombre: 'PL2' },
          isCreator: true,
          counterpart: null,
        })),
        nextCursor: null,
      });
    }

    if (url.endsWith('/offers') && init?.method === 'POST') {
      const idemKey = headers['Idempotency-Key'];
      const cached = idemCache.get(idemKey);
      if (cached) return json(cached, 201);

      const created = { id: `off_${offersCreated.length + 1}`, status: 'OPEN' };
      offersCreated.push({
        id: created.id,
        asignaturaId: String(body.asignaturaId),
        idempotencyKey: idemKey,
      });
      idemCache.set(idemKey, created);
      return json(created, 201);
    }

    return json({ error: 'No encontrado', code: 'NOT_FOUND' }, 404);
  };

  const telegramFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
    sentToTelegram.push({ chat_id: payload.chat_id, text: payload.text });
    return json({ ok: true, result: { message_id: sentToTelegram.length } });
  };

  const outbound = new OutboundQueue({
    botToken: '123:e2e-bot-token',
    perChatIntervalMs: 0,
    fetchImpl: telegramFetch,
  });

  const serviceAuth = new ServiceAuthManager({
    coreApiUrl: 'http://backend:3000/api/v1',
    clientId: 'telegram-bot',
    clientSecret: 'super-secret-de-al-menos-32-caracteres-seguros',
    fetchImpl: coreFetch,
  });

  const sessionManager = new ChannelSessionManager({
    coreApiUrl: 'http://backend:3000/api/v1',
    redis,
    accountsRepo,
    serviceAuth,
    fetchImpl: coreFetch,
  });

  const core = new HttpCoreClient({
    coreApiUrl: 'http://backend:3000/api/v1',
    serviceAuth,
    sessionManager,
    catalogCache,
    fetchImpl: coreFetch,
  });

  const handlers: BotEventHandlers = {
    onNotificationCreated: async () => undefined,
    onOfferMessageCreated: async () => undefined,
    onOfferStatusChanged: async () => undefined,
    onChannelLinkApproved: async (chatId) => {
      await outbound.sendMessage(chatId, 'Vinculado correctamente');
    },
    onChannelLinkDenied: async () => undefined,
    onChannelSessionRevoked: async (chatId) => {
      await outbound.sendMessage(chatId, 'Sesión revocada');
    },
    onAccountBlocked: async (chatId, evt) => {
      await outbound.sendMessage(chatId, `Cuenta bloqueada: ${evt.reason}`);
    },
    onAccountUnblocked: async () => undefined,
  };

  const dispatcher = new BotEventDispatcher({
    accountsRepo,
    sessionManager,
    pendingLinkStore,
    catalogCache,
    coreClient: core,
    handlers,
  });

  const consumer = new RedisEventStreamConsumer({
    redis,
    dedupStore,
    dispatcher,
  });

  const webhookSecret = 'e2e-webhook-secret';
  const server = new BotHttpServer({
    webhookSecret,
    dedupStore,
    onUpdate: async (update) => {
      const fromId = String(update.message?.from?.id ?? '');
      const chatId = String(update.message?.chat.id ?? '');
      const text = update.message?.text ?? '';

      if (text === '/vincular') {
        const req = await core.createLinkRequest({
          externalUserId: fromId,
          chatId,
          displayName: update.message?.from?.first_name ?? 'Estudiante',
        });
        await pendingLinkStore.save(fromId, {
          deviceCode: req.deviceCode,
          userCode: req.userCode,
          chatId,
          displayName: 'Ana Pérez',
          createdAt: new Date().toISOString(),
        });
        await outbound.sendMessage(chatId, `Código: ${req.userCode}`);
      } else if (text === '/ofertar') {
        await core.createOffer(
          fromId,
          { asignaturaId: 'asig_daw', grupoActualId: 'g1', grupoDeseadoId: 'g2' },
          { updateId: update.update_id },
        );
      }
    },
  });

  return {
    redis,
    db,
    core,
    consumer,
    server,
    webhookSecret,
    sentToTelegram,
    offersCreated,
    setBlocked: (v: boolean) => {
      blockedUser = v;
    },
  };
}

describe('Bloque 6: Integración End-to-End y Despliegue Docker/Nginx', () => {
  it('CA-18 y CA-19: /vincular -> channel.link.approved -> /ofertar idempotente -> /misofertas', async () => {
    const stack = createE2EStack();

    // 1. CA-18: Webhook /vincular genera linkRequest y avisa por OutboundQueue
    const linkWebhook = await sendWebhook(stack.server, stack.webhookSecret, {
      update_id: 5001,
      message: {
        message_id: 1,
        from: { id: 551, first_name: 'Ana' },
        chat: { id: 551, type: 'private' },
        text: '/vincular',
      },
    });
    expect(linkWebhook.status).toBe(200);
    await stack.server.drain();
    expect(stack.sentToTelegram[0]).toEqual({ chat_id: '551', text: 'Código: E2E1-2345' });

    // 2. El usuario aprueba en web -> Core publica channel.link.approved -> consumidor canjea sesión y cifra en bot-db
    stack.redis.publishEvent({
      id: 'evt_link_1',
      type: 'channel.link.approved',
      version: 1,
      occurredAt: '2026-11-18T12:00:00.000Z',
      producer: 'xchanger-core',
      audience: ['usr_ana'],
      data: { channel: 'telegram', externalUserId: '551', linkRequestId: 'lr_1' },
    });
    await stack.consumer.processAvailable();

    expect(await stack.core.isLinked('551')).toBe(true);
    expect(stack.db.rows.get('551')?.refresh_token_enc).toMatch(/^v1:/);
    expect(stack.sentToTelegram[1]).toEqual({ chat_id: '551', text: 'Vinculado correctamente' });

    // 3. CA-19: Telegram reintenta el mismo update_id=5002 -> dedup en webhook + solo 1 oferta creada
    const offerUpdate: TelegramUpdate = {
      update_id: 5002,
      message: {
        message_id: 2,
        from: { id: 551, first_name: 'Ana' },
        chat: { id: 551, type: 'private' },
        text: '/ofertar',
      },
    };
    const res1 = await sendWebhook(stack.server, stack.webhookSecret, offerUpdate);
    await stack.server.drain();
    const res2 = await sendWebhook(stack.server, stack.webhookSecret, offerUpdate);

    expect(res1.json).toEqual({ ok: true });
    expect(res2.json).toEqual({ ok: true, duplicate: true });
    expect(stack.offersCreated).toHaveLength(1);
    expect(stack.offersCreated[0].idempotencyKey).toBe('tg:5002');

    // 4. /misofertas devuelve la oferta usando las dos llaves S+U
    const myOffers = await stack.core.listMyOffers('551');
    expect(myOffers.items).toHaveLength(1);
    expect(myOffers.items[0].id).toBe('off_1');
  });

  it('CA-20 y CA-22: bloqueo revoca sesión e informa una vez; login OTP con MFA exige segundo factor', async () => {
    const stack = createE2EStack();

    // CA-22: /entrar con MFA activo exige XOTP y luego emite sesión
    const otpChallenge = await stack.core.sendEmailOtp('552', 'luis@alumnos.unican.es');
    const step1 = await stack.core.verifyEmailOtp(
      { externalUserId: '552', chatId: '552', displayName: 'Luis' },
      otpChallenge.challengeToken,
      '123456',
    );
    expect(step1).toEqual({
      kind: 'mfa_required',
      challengeToken: 'ch_mfa_step2',
      expiresIn: 300,
      methods: ['xotp', 'recovery_code'],
    });

    const step2 = await stack.core.verifyMfa(
      { externalUserId: '552', chatId: '552', displayName: 'Luis' },
      'ch_mfa_step2',
      { code: '654321' },
    );
    expect(step2.user.mfaEnabled).toBe(true);
    expect(await stack.core.isLinked('552')).toBe(true);

    // CA-20: Bloqueo de usuario en Core -> borra sesión local, avisa una vez y rechaza llamadas
    stack.setBlocked(true);
    stack.redis.publishEvent({
      id: 'evt_block_1',
      type: 'account.blocked',
      version: 1,
      occurredAt: '2026-11-18T12:01:00.000Z',
      producer: 'xchanger-core',
      audience: ['usr_ana'],
      data: { userId: 'usr_ana', permanent: true, until: null, reason: 'Incumplimiento' },
    });
    stack.redis.publishEvent({
      id: 'evt_rev_1',
      type: 'channel.session.revoked',
      version: 1,
      occurredAt: '2026-11-18T12:01:01.000Z',
      producer: 'xchanger-core',
      audience: ['usr_ana'],
      data: {
        channel: 'telegram',
        externalUserId: '552',
        sessionId: 'cs_e2e_1',
        reason: 'BLOCKED',
      },
    });
    await stack.consumer.processAvailable();

    expect(await stack.core.isLinked('552')).toBe(false);
    expect(stack.sentToTelegram).toEqual([{ chat_id: '552', text: 'Cuenta bloqueada: Incumplimiento' }]);
    await expect(stack.core.listMyOffers('552')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('valida la configuración de Dockerfile, docker-compose.yml y plantillas de Nginx (§12.1 y §12.2)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');

    const dockerfile = fs.readFileSync(path.join(repoRoot, 'telegram-bot', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM node:20-alpine AS builder');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');

    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('bot-db:');
    expect(compose).toContain('telegram-bot:');
    expect(compose).toContain('bot_db_data:');
    expect(compose).toContain('http://127.0.0.1:8080/healthz');

    const nginxMain = fs.readFileSync(path.join(repoRoot, 'nginx', 'nginx.conf'), 'utf8');
    expect(nginxMain).toContain('upstream telegram_bot');
    expect(nginxMain).toContain('server telegram-bot:8080;');

    for (const tpl of ['http.conf.template', 'https.conf.template']) {
      const conf = fs.readFileSync(path.join(repoRoot, 'nginx', tpl), 'utf8');
      expect(conf).toContain('location = /telegram/webhook');
      expect(conf).toContain('limit_except POST');
      expect(conf).toContain('client_max_body_size 1m;');
      expect(conf).toContain('proxy_pass         http://telegram_bot;');
    }
  });
});
