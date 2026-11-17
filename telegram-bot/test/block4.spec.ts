import crypto from 'crypto';
import { Queryable } from '../src/back/config/db';
import { RedisCatalogCache } from '../src/back/core/catalog-cache';
import { ServiceAuthManager } from '../src/back/core/service-auth';
import { ChannelSessionManager } from '../src/back/core/session-manager';
import { TokenCipher } from '../src/back/crypto/token-cipher';
import {
  MAX_EVENT_DELIVERIES,
  RedisEventStreamConsumer,
  RedisStreamClient,
  StreamEntry,
} from '../src/back/events/event-consumer';
import { BotEventDispatcher, CoreEventEnvelope } from '../src/back/events/event-dispatcher';
import { TelegramAccountsRepository } from '../src/back/storage/accounts.repo';
import {
  RedisDedupStore,
  RedisLike,
  RedisPendingLinkStore,
} from '../src/back/storage/redis-stores';
import { BotEventHandlers, CoreApiError } from '../src/contracts';

class FakeStreamRedis implements RedisLike, RedisStreamClient {
  readonly data = new Map<string, { value: string; ttlSec: number }>();
  private readonly stream: Array<{ id: string; fields: string[] }> = [];
  private readonly groups = new Set<string>();
  private deliveredIndex = 0;
  private readonly pending = new Map<string, string[]>();
  private seq = 0;

  async get(key: string): Promise<string | null> {
    return this.data.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    _secondsToken: 'EX',
    seconds: number,
    nxToken?: 'NX',
  ): Promise<string | null> {
    if (nxToken === 'NX' && this.data.has(key)) return null;
    this.data.set(key, { value, ttlSec: seconds });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.data.delete(k)) removed += 1;
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.data.has(k)).length;
  }

  pushEvent(envelope: CoreEventEnvelope): string {
    this.seq += 1;
    const id = `${this.seq}-0`;
    this.stream.push({ id, fields: ['event', JSON.stringify(envelope)] });
    return id;
  }

  pushRaw(fields: string[]): string {
    this.seq += 1;
    const id = `${this.seq}-0`;
    this.stream.push({ id, fields });
    return id;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async xgroup(
    _command: 'CREATE',
    stream: string,
    group: string,
  ): Promise<unknown> {
    const key = `${stream}:${group}`;
    if (this.groups.has(key)) throw new Error('BUSYGROUP Consumer Group name already exists');
    this.groups.add(key);
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
    const entries: StreamEntry[] = [...this.pending.entries()].map(([id, fields]) => [id, fields]);
    return ['0-0', entries];
  }

  async xack(_stream: string, _group: string, id: string): Promise<number> {
    return this.pending.delete(id) ? 1 : 0;
  }
}

interface StoredRow {
  telegram_user_id: string;
  chat_id: string;
  core_user_id: string;
  channel_session_id: string;
  refresh_token_enc: string;
  locale: string;
  linked_at: Date;
}

class FakeBotDb implements Queryable {
  readonly rows = new Map<string, StoredRow>();

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

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE telegram_user_id = $1')) {
      const ok = this.rows.delete(params[0] as string);
      return { rows: [], rowCount: ok ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE core_user_id = $1')) {
      const target = params[0] as string;
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.core_user_id === target) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE channel_session_id = $1')) {
      const target = params[0] as string;
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.channel_session_id === target) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`Consulta SQL no soportada en FakeBotDb: ${sql}`);
  }
}

function makeHandlers(): jest.Mocked<BotEventHandlers> {
  return {
    onNotificationCreated: jest.fn().mockResolvedValue(undefined),
    onOfferMessageCreated: jest.fn().mockResolvedValue(undefined),
    onOfferStatusChanged: jest.fn().mockResolvedValue(undefined),
    onChannelLinkApproved: jest.fn().mockResolvedValue(undefined),
    onChannelLinkDenied: jest.fn().mockResolvedValue(undefined),
    onChannelSessionRevoked: jest.fn().mockResolvedValue(undefined),
    onAccountBlocked: jest.fn().mockResolvedValue(undefined),
    onAccountUnblocked: jest.fn().mockResolvedValue(undefined),
  };
}

function makeEnvelope(
  type: string,
  data: Record<string, unknown>,
  audience: string[] = [],
  id = `evt_${Math.random().toString(36).slice(2, 10)}`,
  occurredAt = '2026-11-17T20:00:00.000Z',
): CoreEventEnvelope {
  return {
    id,
    type,
    version: 1,
    occurredAt,
    producer: 'xchanger-core',
    requestId: '01JREQ1',
    audience,
    data,
  };
}

function createHarness() {
  const redis = new FakeStreamRedis();
  const db = new FakeBotDb();
  const cipher = new TokenCipher(crypto.randomBytes(32).toString('base64'));
  const accountsRepo = new TelegramAccountsRepository(db, cipher);
  const serviceAuth = new ServiceAuthManager({
    coreApiUrl: 'http://core:3000/api/v1',
    clientId: 'telegram-bot',
    clientSecret: 'super-secret-de-al-menos-32-caracteres-seguros',
  });
  const sessionManager = new ChannelSessionManager({
    coreApiUrl: 'http://core:3000/api/v1',
    redis,
    accountsRepo,
    serviceAuth,
  });
  const pendingLinkStore = new RedisPendingLinkStore(redis);
  const dedupStore = new RedisDedupStore(redis);
  const catalogCache = new RedisCatalogCache(redis, 300);
  const handlers = makeHandlers();

  const exchangeLinkCodeMock = jest.fn().mockResolvedValue({
    kind: 'session',
    sessionId: 'cs_linked',
    absoluteExpiresAt: '2027-05-02T10:00:00Z',
    user: {
      id: 'usr_ana',
      name: 'Ana',
      role: 'ESTUDIANTE',
      mfaEnabled: false,
      hasExpediente: true,
    },
  });

  const dispatcher = new BotEventDispatcher({
    accountsRepo,
    sessionManager,
    pendingLinkStore,
    catalogCache,
    coreClient: { exchangeLinkCode: exchangeLinkCodeMock },
    handlers,
  });

  const consumer = new RedisEventStreamConsumer({
    redis,
    dedupStore,
    dispatcher,
    nowMs: () => Date.parse('2026-11-17T20:00:01.250Z'),
  });

  return {
    redis,
    db,
    accountsRepo,
    sessionManager,
    pendingLinkStore,
    dedupStore,
    catalogCache,
    handlers,
    exchangeLinkCodeMock,
    dispatcher,
    consumer,
  };
}

describe('Bloque 4: Consumidor de Eventos (xchanger:events)', () => {
  it('crea grupo (tolera BUSYGROUP), deduplica por event.id, calcula lag y confirma XACK', async () => {
    const { redis, sessionManager, handlers, consumer } = createHarness();

    await sessionManager.saveIssuedSession(
      { externalUserId: '551', chatId: '551', displayName: 'Ana' },
      {
        accessToken: 'acc_1',
        accessTokenExpiresIn: 900,
        refreshToken: 'ref_1',
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_1', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_ana',
          name: 'Ana',
          role: 'ESTUDIANTE',
          mfaEnabled: false,
          hasExpediente: true,
        },
      },
    );

    const dupEvent = makeEnvelope(
      'offer.status.changed',
      {
        offerId: 'off_1',
        from: 'OPEN',
        to: 'ACCEPTED',
        actorId: 'usr_carlos',
        asignatura: { codigo: 'G1234', nombre: 'DAW' },
      },
      ['usr_ana'],
      'evt_same_id',
      '2026-11-17T20:00:00.000Z',
    );

    redis.pushEvent(dupEvent);
    redis.pushEvent(dupEvent); // Reentrega con el mismo event.id
    redis.pushRaw(['not_event', 'broken']); // Mensaje malformado

    await consumer.ensureGroup();
    const processed = await consumer.processAvailable();

    expect(processed).toBe(3);
    expect(handlers.onOfferStatusChanged).toHaveBeenCalledTimes(1);
    expect(redis.pendingCount()).toBe(0);
    expect(redis.data.get('tg:evt:done:evt_same_id')?.value).toBe('1');
    expect(consumer.getConsumerLagMs()).toBe(1250);
  });

  it('reintenta vía XAUTOCLAIM con tg:evt:tries:* y confirma tras 5 fallos (MAX_EVENT_DELIVERIES)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { redis, sessionManager, handlers, consumer } = createHarness();

      await sessionManager.saveIssuedSession(
        { externalUserId: '551', chatId: '551', displayName: 'Ana' },
        {
          accessToken: 'acc_1',
          accessTokenExpiresIn: 900,
          refreshToken: 'ref_1',
          refreshTokenExpiresIn: 2592000,
          session: { id: 'cs_1', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
          user: {
            id: 'usr_ana',
            name: 'Ana',
            role: 'ESTUDIANTE',
            mfaEnabled: false,
            hasExpediente: true,
          },
        },
      );

      // 1) Fallo transitorio: falla 1 vez en lectura inicial, tiene éxito al reclamar con XAUTOCLAIM
      handlers.onAccountUnblocked
        .mockRejectedValueOnce(new Error('Telegram 500'))
        .mockResolvedValueOnce(undefined);

      redis.pushEvent(makeEnvelope('account.unblocked', { userId: 'usr_ana' }, ['usr_ana'], 'evt_flaky'));
      await consumer.processAvailable();

      // Como processAvailable() ya ejecuta reclaimStale(0) al final, el 2º intento tuvo éxito y limpió todo
      expect(handlers.onAccountUnblocked).toHaveBeenCalledTimes(2);
      expect(redis.pendingCount()).toBe(0);
      expect(redis.data.has('tg:evt:tries:evt_flaky')).toBe(false);
      expect(redis.data.has('tg:evt:done:evt_flaky')).toBe(true);

      // 2) Fallo permanente: falla los 5 intentos y al 5º hace XACK para no bloquear la cola
      handlers.onAccountUnblocked.mockRejectedValue(new Error('Persistent error'));
      redis.pushEvent(makeEnvelope('account.unblocked', { userId: 'usr_ana' }, ['usr_ana'], 'evt_dead'));

      // 1ª lectura en processAvailable() + 1 reclaim inicial = 2 intentos
      await consumer.processAvailable();
      expect(redis.pendingCount()).toBe(1);
      expect(redis.data.get('tg:evt:tries:evt_dead')?.value).toBe('2');

      // Reintentos 3 y 4 siguen pendientes; el 5º alcanza MAX_EVENT_DELIVERIES y confirma XACK
      await consumer.reclaimStale(0);
      await consumer.reclaimStale(0);
      expect(redis.pendingCount()).toBe(1);
      await consumer.reclaimStale(0);

      expect(redis.data.get('tg:evt:tries:evt_dead')?.value).toBe(String(MAX_EVENT_DELIVERIES));
      expect(redis.pendingCount()).toBe(0);
      expect(redis.data.has('tg:evt:done:evt_dead')).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('filtra por audience contra bot-db y descarta eventos de usuarios no vinculados', async () => {
    const { redis, handlers, consumer } = createHarness();

    redis.pushEvent(
      makeEnvelope(
        'notification.created',
        {
          notificationId: 'n1',
          userId: 'usr_ajeno',
          asunto: 'Privado',
          contenido: 'No debería llegar',
          kind: 'GENERAL',
          refs: {},
        },
        ['usr_ajeno'],
      ),
    );
    redis.pushEvent(
      makeEnvelope(
        'offer.message.created',
        {
          offerId: 'off_9',
          messageId: 'm1',
          authorId: 'usr_a',
          authorName: 'Otro',
          content: 'Secreto',
          timestamp: '2026-11-17T20:00:00Z',
        },
        ['usr_a', 'usr_b'],
      ),
    );

    await consumer.processAvailable();

    expect(handlers.onNotificationCreated).not.toHaveBeenCalled();
    expect(handlers.onOfferMessageCreated).not.toHaveBeenCalled();
  });

  it('canjea deviceCode en channel.link.approved (tolerando INVALID_GRANT) y limpia channel.link.denied', async () => {
    const {
      redis,
      pendingLinkStore,
      handlers,
      exchangeLinkCodeMock,
      consumer,
    } = createHarness();

    await pendingLinkStore.save('555111', {
      deviceCode: 'dev_111',
      userCode: 'ABCD-1234',
      chatId: 'chat_111',
      displayName: 'Carlos',
      username: 'carlos_tg',
      createdAt: '2026-11-17T19:59:00Z',
    });

    await pendingLinkStore.save('555222', {
      deviceCode: 'dev_222',
      userCode: 'EFGH-5678',
      chatId: 'chat_222',
      displayName: 'Lucía',
      createdAt: '2026-11-17T19:59:00Z',
    });

    // Incluso si el sondeo ganó la carrera (INVALID_GRANT), limpia pendiente y avisa al chat
    exchangeLinkCodeMock.mockRejectedValueOnce(
      new CoreApiError(400, 'INVALID_GRANT', 'Ya consumido'),
    );

    redis.pushEvent(
      makeEnvelope('channel.link.approved', {
        channel: 'telegram',
        externalUserId: '555111',
        linkRequestId: 'lr_1',
      }),
    );
    redis.pushEvent(
      makeEnvelope('channel.link.denied', {
        channel: 'telegram',
        externalUserId: '555222',
        linkRequestId: 'lr_2',
      }),
    );

    await consumer.processAvailable();

    expect(exchangeLinkCodeMock).toHaveBeenCalledWith(
      {
        externalUserId: '555111',
        chatId: 'chat_111',
        displayName: 'Carlos',
        username: 'carlos_tg',
      },
      'dev_111',
    );
    expect(await pendingLinkStore.get('555111')).toBeNull();
    expect(await pendingLinkStore.get('555222')).toBeNull();
    expect(handlers.onChannelLinkApproved).toHaveBeenCalledWith('chat_111', {
      channel: 'telegram',
      externalUserId: '555111',
      linkRequestId: 'lr_1',
    });
    expect(handlers.onChannelLinkDenied).toHaveBeenCalledWith('chat_222', {
      channel: 'telegram',
      externalUserId: '555222',
      linkRequestId: 'lr_2',
    });
  });

  it('limpia sesión en account.blocked / channel.session.revoked sin duplicar aviso en BLOCKED', async () => {
    const { redis, db, sessionManager, handlers, consumer } = createHarness();

    await sessionManager.saveIssuedSession(
      { externalUserId: '551', chatId: 'chat_ana', displayName: 'Ana' },
      {
        accessToken: 'acc_ana',
        accessTokenExpiresIn: 900,
        refreshToken: 'ref_ana',
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_ana', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_ana',
          name: 'Ana',
          role: 'ESTUDIANTE',
          mfaEnabled: false,
          hasExpediente: true,
        },
      },
    );

    await sessionManager.saveIssuedSession(
      { externalUserId: '552', chatId: 'chat_luis', displayName: 'Luis' },
      {
        accessToken: 'acc_luis',
        accessTokenExpiresIn: 900,
        refreshToken: 'ref_luis',
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_luis', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_luis',
          name: 'Luis',
          role: 'ESTUDIANTE',
          mfaEnabled: false,
          hasExpediente: true,
        },
      },
    );

    // 1. Bloqueo de Ana seguido de channel.session.revoked(reason=BLOCKED)
    redis.pushEvent(
      makeEnvelope(
        'account.blocked',
        { userId: 'usr_ana', permanent: true, until: null, reason: 'Abuso' },
        ['usr_ana'],
      ),
    );
    redis.pushEvent(
      makeEnvelope(
        'channel.session.revoked',
        {
          channel: 'telegram',
          externalUserId: '551',
          sessionId: 'cs_ana',
          reason: 'BLOCKED',
        },
        ['usr_ana'],
      ),
    );

    // 2. Desvinculación normal de Luis (reason=USER)
    redis.pushEvent(
      makeEnvelope(
        'channel.session.revoked',
        {
          channel: 'telegram',
          externalUserId: '552',
          sessionId: 'cs_luis',
          reason: 'USER',
        },
        ['usr_luis'],
      ),
    );

    await consumer.processAvailable();

    expect(await redis.exists('tg:sess:access:551', 'tg:sess:access:552')).toBe(0);
    expect(db.rows.size).toBe(0);
    expect(handlers.onAccountBlocked).toHaveBeenCalledTimes(1);
    expect(handlers.onAccountBlocked).toHaveBeenCalledWith('chat_ana', {
      userId: 'usr_ana',
      permanent: true,
      until: null,
      reason: 'Abuso',
    });
    expect(handlers.onChannelSessionRevoked).toHaveBeenCalledTimes(1);
    expect(handlers.onChannelSessionRevoked).toHaveBeenCalledWith('chat_luis', {
      channel: 'telegram',
      externalUserId: '552',
      sessionId: 'cs_luis',
      reason: 'USER',
    });
  });

  it('invalida caché ante academic.changed, respeta delivery en notificaciones y entrega chat a ambos participantes', async () => {
    const {
      redis,
      sessionManager,
      catalogCache,
      handlers,
      consumer,
    } = createHarness();

    await catalogCache.setCareers([{ id: 'c1', nombre: 'Informática' }]);
    await catalogCache.setCourses('c1', [{ id: 'cur1', nombre: '1º' }]);
    await catalogCache.setGroups('a1', [{ id: 'g1', nombre: 'PL1' }]);

    await sessionManager.saveIssuedSession(
      { externalUserId: '551', chatId: 'chat_ana', displayName: 'Ana' },
      {
        accessToken: 'acc_ana',
        accessTokenExpiresIn: 900,
        refreshToken: 'ref_ana',
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_ana', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_ana',
          name: 'Ana',
          role: 'ESTUDIANTE',
          mfaEnabled: false,
          hasExpediente: true,
        },
      },
    );
    await sessionManager.saveIssuedSession(
      { externalUserId: '552', chatId: 'chat_luis', displayName: 'Luis' },
      {
        accessToken: 'acc_luis',
        accessTokenExpiresIn: 900,
        refreshToken: 'ref_luis',
        refreshTokenExpiresIn: 2592000,
        session: { id: 'cs_luis', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
        user: {
          id: 'usr_luis',
          name: 'Luis',
          role: 'ESTUDIANTE',
          mfaEnabled: false,
          hasExpediente: true,
        },
      },
    );

    // Invalidación académica (GRUPO solo invalida grupos, no carreras ni cursos)
    redis.pushEvent(makeEnvelope('academic.changed', { entity: 'GRUPO', id: 'g1', action: 'CREATED' }));

    // Notificación con telegram=false -> silenciada
    redis.pushEvent(
      makeEnvelope(
        'notification.created',
        {
          notificationId: 'n_muted',
          userId: 'usr_ana',
          asunto: 'Silenciada',
          contenido: '...',
          kind: 'GENERAL',
          refs: {},
          delivery: { telegram: false, telegramChatMessages: true },
        },
        ['usr_ana'],
      ),
    );

    // Notificación CHAT_MESSAGE con telegramChatMessages=false -> silenciada
    redis.pushEvent(
      makeEnvelope(
        'notification.created',
        {
          notificationId: 'n_chat_muted',
          userId: 'usr_ana',
          asunto: 'Nuevo mensaje',
          contenido: '...',
          kind: 'CHAT_MESSAGE',
          refs: { offerId: 'off_1' },
          delivery: { telegram: true, telegramChatMessages: false },
        },
        ['usr_ana'],
      ),
    );

    // Notificación habilitada -> entregada
    redis.pushEvent(
      makeEnvelope(
        'notification.created',
        {
          notificationId: 'n_ok',
          userId: 'usr_ana',
          asunto: 'Oferta aceptada',
          contenido: 'Luis aceptó tu oferta',
          kind: 'OFFER_ACCEPTED',
          refs: { offerId: 'off_1' },
          delivery: { telegram: true, telegramChatMessages: false },
        },
        ['usr_ana'],
      ),
    );

    // Mensaje de chat -> entregado a ambos participantes (para reflejar mensajes enviados desde web)
    redis.pushEvent(
      makeEnvelope(
        'offer.message.created',
        {
          offerId: 'off_1',
          messageId: 'm_1',
          authorId: 'usr_ana',
          authorName: 'Ana',
          content: 'Hola!',
          timestamp: '2026-11-17T20:00:00Z',
        },
        ['usr_ana', 'usr_luis'],
      ),
    );

    await consumer.processAvailable();

    expect(await catalogCache.getCareers()).not.toBeNull();
    expect(await catalogCache.getCourses('c1')).not.toBeNull();
    expect(await catalogCache.getGroups('a1')).toBeNull();

    expect(handlers.onNotificationCreated).toHaveBeenCalledTimes(1);
    expect(handlers.onNotificationCreated).toHaveBeenCalledWith(
      'chat_ana',
      expect.objectContaining({ notificationId: 'n_ok' }),
    );

    expect(handlers.onOfferMessageCreated).toHaveBeenCalledTimes(2);
    expect(handlers.onOfferMessageCreated).toHaveBeenCalledWith(
      'chat_ana',
      'usr_ana',
      expect.objectContaining({ messageId: 'm_1' }),
    );
    expect(handlers.onOfferMessageCreated).toHaveBeenCalledWith(
      'chat_luis',
      'usr_luis',
      expect.objectContaining({ messageId: 'm_1' }),
    );
  });
});
