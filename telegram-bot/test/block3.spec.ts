import crypto from 'crypto';
import { Queryable } from '../src/back/config/db';
import { RedisCatalogCache } from '../src/back/core/catalog-cache';
import { HttpCoreClient } from '../src/back/core/http-core.client';
import { ServiceAuthManager } from '../src/back/core/service-auth';
import {
  ChannelSessionManager,
  CoreIssuedSessionPayload,
} from '../src/back/core/session-manager';
import { TokenCipher } from '../src/back/crypto/token-cipher';
import { TelegramAccountsRepository } from '../src/back/storage/accounts.repo';
import { RedisLike } from '../src/back/storage/redis-stores';
import { CoreApiError, TelegramIdentityInput } from '../src/contracts';

class FakeRedis implements RedisLike {
  readonly data = new Map<string, { value: string; ttlSec: number }>();

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
    if (nxToken === 'NX' && this.data.has(key)) {
      return null;
    }
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

    if (sql.startsWith('UPDATE telegram_accounts')) {
      const [tgId, sessionId, encToken] = params as string[];
      const existing = this.rows.get(tgId);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.channel_session_id = sessionId;
      existing.refresh_token_enc = encToken;
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE telegram_user_id = $1')) {
      const ok = this.rows.delete(params[0] as string);
      return { rows: [], rowCount: ok ? 1 : 0 };
    }

    throw new Error(`Consulta SQL no soportada en FakeBotDb: ${sql}`);
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
  });
}

function makeIssuedPayload(suffix: string): CoreIssuedSessionPayload {
  return {
    accessToken: `acc_${suffix}`,
    accessTokenExpiresIn: 900,
    refreshToken: `ref_${suffix}`,
    refreshTokenExpiresIn: 2592000,
    session: { id: `cs_${suffix}`, absoluteExpiresAt: '2027-05-02T10:00:00Z' },
    user: {
      id: 'usr_1',
      name: 'Ana Pérez',
      role: 'ESTUDIANTE',
      mfaEnabled: false,
      hasExpediente: true,
    },
  };
}

function createHarness(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  let serviceTokenCalls = 0;
  const fetchMock: jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>> = jest.fn(
    async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/service-auth/token')) {
        serviceTokenCalls += 1;
        return jsonResponse({
          access_token: `svc_jwt_${serviceTokenCalls}`,
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'channel:telegram',
        });
      }
      return handler(url, init);
    },
  );

  const redis = new FakeRedis();
  const db = new FakeBotDb();
  const cipher = new TokenCipher(crypto.randomBytes(32).toString('base64'));
  const accountsRepo = new TelegramAccountsRepository(db, cipher);

  const serviceAuth = new ServiceAuthManager({
    coreApiUrl: 'http://core:3000/api/v1',
    clientId: 'telegram-bot',
    clientSecret: 'super-secret-de-al-menos-32-caracteres-seguros',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  const sessionManager = new ChannelSessionManager({
    coreApiUrl: 'http://core:3000/api/v1',
    redis,
    accountsRepo,
    serviceAuth,
    fetchImpl: fetchMock as unknown as typeof fetch,
    lockPollMs: 5,
    lockWaitMs: 500,
  });

  const catalogCache = new RedisCatalogCache(redis, 300);

  const client = new HttpCoreClient({
    coreApiUrl: 'http://core:3000/api/v1',
    serviceAuth,
    sessionManager,
    catalogCache,
    fetchImpl: fetchMock as unknown as typeof fetch,
    timeoutMs: 2000,
  });

  return { client, redis, db, sessionManager, serviceAuth, catalogCache, fetchMock };
}

const TG: TelegramIdentityInput = {
  externalUserId: '555001',
  chatId: '555001',
  displayName: 'Ana Pérez',
  username: 'anaperez',
};

describe('Bloque 3: HttpCoreClient (REST /api/v1 + Caché)', () => {
  it('gestiona los flujos S de vinculación, email OTP (con y sin MFA), registro e idempotencia', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];

    const { client, db, fetchMock } = createHarness((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method: init?.method ?? 'GET', headers, body });

      if (url.endsWith('/channel-auth/link-requests')) {
        return jsonResponse(
          {
            deviceCode: 'dev_abc',
            userCode: 'ABCD-2345',
            verificationUri: 'https://xchanger.test/vincular',
            verificationUriComplete: 'https://xchanger.test/vincular?code=ABCD-2345',
            expiresIn: 600,
            interval: 5,
          },
          201,
        );
      }

      if (url.endsWith('/channel-auth/email-otp')) {
        return jsonResponse({ challengeToken: 'ch_otp', expiresIn: 600, codeLength: 6 }, 202);
      }

      if (url.endsWith('/channel-auth/register')) {
        return jsonResponse({ challengeToken: 'ch_reg', expiresIn: 1800, codeLength: 6 }, 202);
      }

      if (url.endsWith('/channel-auth/token')) {
        const payload = body as { grant_type: string; code?: string };
        if (payload.grant_type === 'email_otp' && payload.code === '111111') {
          return jsonResponse({
            mfaRequired: true,
            challengeToken: 'ch_mfa',
            expiresIn: 300,
            methods: ['xotp', 'recovery_code'],
          });
        }
        return jsonResponse(makeIssuedPayload(payload.grant_type));
      }

      return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    });

    expect(await client.isLinked(TG.externalUserId)).toBe(false);

    // 1. Vinculación (EP-C-03 + EP-C-06 link_code)
    const linkReq = await client.createLinkRequest(TG);
    expect(linkReq.userCode).toBe('ABCD-2345');
    expect(seen[0].headers['X-Service-Authorization']).toBe('Bearer svc_jwt_1');
    expect(seen[0].headers['Authorization']).toBeUndefined();
    expect(seen[0].headers['X-Request-Id']).toMatch(/^[0-9A-Z]{26}$/);
    expect(seen[0].headers['Accept-Language']).toBe('es');

    const linkSess = await client.exchangeLinkCode(TG, 'dev_abc');
    expect(linkSess.kind).toBe('session');
    expect(await client.isLinked(TG.externalUserId)).toBe(true);
    expect(db.rows.has(TG.externalUserId)).toBe(true);

    // 2. Email OTP -> MFA required y posterior verifyMfa
    const otpChallenge = await client.sendEmailOtp(TG.externalUserId, 'ana@alumnos.unican.es');
    expect(otpChallenge.challengeToken).toBe('ch_otp');

    const mfaRes = await client.verifyEmailOtp(TG, 'ch_otp', '111111');
    expect(mfaRes).toEqual({
      kind: 'mfa_required',
      challengeToken: 'ch_mfa',
      expiresIn: 300,
      methods: ['xotp', 'recovery_code'],
    });

    const mfaIssued = await client.verifyMfa(TG, 'ch_mfa', { recoveryCode: 'ABCDE-12345' });
    expect(mfaIssued.sessionId).toBe('cs_mfa');

    // 3. Registro con Idempotency-Key (tg:<updateId> y UUID v4) + verification
    await client.registerFromTelegram(
      {
        externalUserId: TG.externalUserId,
        name: 'Ana Pérez',
        email: 'ana@alumnos.unican.es',
        carreraId: 'car_1',
        cursoId: 'cur_1',
        acceptTerms: true,
      },
      { updateId: 42001 },
    );
    expect(seen[seen.length - 1].headers['Idempotency-Key']).toBe('tg:42001');

    await client.registerFromTelegram({
      externalUserId: TG.externalUserId,
      name: 'Ana Pérez',
      email: 'ana@alumnos.unican.es',
      carreraId: 'car_1',
      cursoId: 'cur_1',
      acceptTerms: true,
    });
    expect(seen[seen.length - 1].headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const regIssued = await client.verifyRegistrationOtp(TG, 'ch_reg', '654321');
    expect(regIssued.sessionId).toBe('cs_registration_otp');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('reintenta una única vez ante 401 TOKEN_EXPIRED conservando X-Request-Id e Idempotency-Key y serializa concurrencia', async () => {
    let rotationCount = 0;
    let meAttempts = 0;
    const offerCreateHeaders: Array<{ reqId: string; idem: string; auth: string }> = [];

    const { client, sessionManager } = createHarness((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url.endsWith('/channel-auth/token')) {
        rotationCount += 1;
        return jsonResponse(makeIssuedPayload(`rotated_${rotationCount}`));
      }

      if (url.endsWith('/offers') && init?.method === 'POST') {
        offerCreateHeaders.push({
          reqId: headers['X-Request-Id'],
          idem: headers['Idempotency-Key'],
          auth: headers['Authorization'],
        });
        if (headers['Authorization'] === 'Bearer acc_initial') {
          return jsonResponse(
            { error: 'Sesión de canal expirada', code: 'TOKEN_EXPIRED' },
            401,
          );
        }
        return jsonResponse({ id: 'off_1', status: 'OPEN' }, 201);
      }

      if (url.endsWith('/auth/me')) {
        meAttempts += 1;
        return jsonResponse({ error: 'Aún expirado', code: 'TOKEN_EXPIRED' }, 401);
      }

      return jsonResponse({}, 404);
    });

    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('initial'));

    // Dos llamadas concurrentes que chocan contra acc_initial expirado:
    // solo deben disparar 1 rotación en Core y ambas tener éxito en el reintento único.
    const [o1, o2] = await Promise.all([
      client.createOffer(
        TG.externalUserId,
        { asignaturaId: 'asig_1', grupoActualId: 'g1', grupoDeseadoId: 'g2' },
        { updateId: 100 },
      ),
      client.createOffer(
        TG.externalUserId,
        { asignaturaId: 'asig_1', grupoActualId: 'g1', grupoDeseadoId: 'g2' },
        { updateId: 101 },
      ),
    ]);

    expect(o1.id).toBe('off_1');
    expect(o2.id).toBe('off_1');
    expect(rotationCount).toBe(1);

    // El reintento de updateId=100 conservó exactamente el mismo X-Request-Id y la misma Idempotency-Key
    const for100 = offerCreateHeaders.filter((h) => h.idem === 'tg:100');
    expect(for100).toHaveLength(2);
    expect(for100[0].auth).toBe('Bearer acc_initial');
    expect(for100[1].auth).toBe('Bearer acc_rotated_1');
    expect(for100[0].reqId).toBe(for100[1].reqId);

    // Si tras el reintento vuelve a devolver 401 TOKEN_EXPIRED, no hace bucle infinito y propaga el error
    await expect(client.getProfile(TG.externalUserId)).rejects.toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
    expect(meAttempts).toBe(2);
    expect(rotationCount).toBe(2);
  });

  it('reintenta ante 401 SERVICE_UNAUTHORIZED y limpia sesión ante REVOKED / BLOCKED / revoke()', async () => {
    let blockedNext = false;

    const { client, sessionManager, redis, db } = createHarness((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url.endsWith('/auth/me')) {
        if (headers['X-Service-Authorization'] === 'Bearer svc_jwt_1') {
          return jsonResponse(
            { error: 'Token servicio caducado', code: 'SERVICE_UNAUTHORIZED' },
            401,
          );
        }
        if (blockedNext) {
          return jsonResponse({ error: 'Cuenta bloqueada', code: 'ACCOUNT_BLOCKED' }, 403);
        }
        return jsonResponse({
          id: 'usr_1',
          name: 'Ana',
          email: 'ana@alumnos.unican.es',
          role: 'ESTUDIANTE',
          carreraId: null,
          cursoId: null,
          mfaEnabled: false,
        });
      }

      if (url.endsWith('/channel-auth/revoke')) {
        return jsonResponse({ error: 'Revocada', code: 'SESSION_REVOKED' }, 401);
      }

      return jsonResponse({}, 404);
    });

    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('v1'));

    // Primera llamada sufre SERVICE_UNAUTHORIZED con svc_jwt_1 -> invalida y reintenta con svc_jwt_2
    const profile = await client.getProfile(TG.externalUserId);
    expect(profile.name).toBe('Ana');

    // Si responde ACCOUNT_BLOCKED, limpia Redis y bot-db
    blockedNext = true;
    await expect(client.getProfile(TG.externalUserId)).rejects.toMatchObject({
      status: 403,
      code: 'ACCOUNT_BLOCKED',
    });
    expect(await redis.exists(`tg:sess:access:${TG.externalUserId}`)).toBe(0);
    expect(db.rows.has(TG.externalUserId)).toBe(false);

    // revoke() también es idempotente si el Core ya devuelve 401 SESSION_REVOKED
    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('v2'));
    await expect(client.revoke(TG.externalUserId, 'identity')).resolves.toBeUndefined();
    expect(await client.isLinked(TG.externalUserId)).toBe(false);
  });

  it('cachea catálogo y grupos (5 min), filtra en memoria y los invalida por eventos academic.*', async () => {
    let careersHits = 0;
    let coursesHits = 0;
    let groupsHits = 0;

    const { client, sessionManager, catalogCache, redis } = createHarness((url) => {
      if (url.endsWith('/public/careers')) {
        careersHits += 1;
        return jsonResponse([
          { id: 'car_inf', nombre: `Informática v${careersHits}`, extra: 'ignored' },
          { id: 'car_mat', nombre: 'Matemáticas' },
        ]);
      }

      if (url.endsWith('/public/careers/car_inf/courses')) {
        coursesHits += 1;
        return jsonResponse([{ id: 'cur_1', nombre: `1º v${coursesHits}` }]);
      }

      if (url.endsWith('/subjects/asig_1/groups')) {
        groupsHits += 1;
        return jsonResponse([{ id: 'grp_1', nombre: `PL1 v${groupsHits}` }]);
      }

      return jsonResponse({}, 404);
    });

    // Sin sesión, listSubjectGroups debe fallar incluso antes de cachear
    await expect(client.listSubjectGroups(TG.externalUserId, 'asig_1')).rejects.toBeInstanceOf(
      CoreApiError,
    );
    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('cat'));

    // Carreras: 1 hit HTTP y luego hit Redis + filtro `q`
    const allCareers = await client.listCareers();
    expect(allCareers).toEqual([
      { id: 'car_inf', nombre: 'Informática v1' },
      { id: 'car_mat', nombre: 'Matemáticas' },
    ]);
    expect(redis.data.get('tg:cache:catalog:careers')?.ttlSec).toBe(300);

    const filteredCareers = await client.listCareers('infor');
    expect(filteredCareers).toHaveLength(1);
    expect(careersHits).toBe(1);

    // Cursos y grupos: hits cacheados
    expect((await client.listCourses('car_inf'))[0].nombre).toBe('1º v1');
    expect((await client.listCourses('car_inf'))[0].nombre).toBe('1º v1');
    expect(coursesHits).toBe(1);

    expect((await client.listSubjectGroups(TG.externalUserId, 'asig_1'))[0].nombre).toBe('PL1 v1');
    expect((await client.listSubjectGroups(TG.externalUserId, 'asig_1'))[0].nombre).toBe('PL1 v1');
    expect(groupsHits).toBe(1);

    // Evento GRUPO: invalida grupos, mantiene carreras y cursos
    await catalogCache.invalidateByAcademicEvent('GRUPO');
    expect((await client.listCareers())[0].nombre).toBe('Informática v1');
    expect((await client.listCourses('car_inf'))[0].nombre).toBe('1º v1');
    expect((await client.listSubjectGroups(TG.externalUserId, 'asig_1'))[0].nombre).toBe('PL1 v2');
    expect(careersHits).toBe(1);
    expect(coursesHits).toBe(1);
    expect(groupsHits).toBe(2);

    // Evento CURSO: invalida cursos y grupos, mantiene carreras
    await catalogCache.invalidateByAcademicEvent('CURSO');
    expect((await client.listCourses('car_inf'))[0].nombre).toBe('1º v2');
    expect((await client.listSubjectGroups(TG.externalUserId, 'asig_1'))[0].nombre).toBe('PL1 v3');
    expect(careersHits).toBe(1);

    // Evento CARRERA: invalida todo
    await catalogCache.invalidateByAcademicEvent('CARRERA');
    expect((await client.listCareers())[0].nombre).toBe('Informática v2');
    expect((await client.listCourses('car_inf'))[0].nombre).toBe('1º v3');
    expect((await client.listSubjectGroups(TG.externalUserId, 'asig_1'))[0].nombre).toBe('PL1 v4');
  });

  it('cubre los adaptadores del backend actual y el resto de los 31 métodos de CoreClient', async () => {
    const requests: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];

    const { client, sessionManager } = createHarness((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const method = init?.method ?? 'GET';
      requests.push({ method, url, headers, body });

      if (url.startsWith('http://core:3000/api/v1/public/subjects/search')) {
        if (url.includes('q=pag')) {
          return jsonResponse({
            items: [{ id: 'a1', codigo: 'G1', nombre: 'Paginada', cursoId: 'cur_2' }],
            total: 1,
          });
        }
        // Formato legacy array del backend actual
        return jsonResponse([
          { id: 'a1', codigo: 'G1', nombre: 'S1', cursoId: 'cur_1' },
          { id: 'a2', codigo: 'G2', nombre: 'S2', cursoId: 'cur_2' },
          { id: 'a3', codigo: 'G3', nombre: 'S3', cursoId: 'cur_2' },
        ]);
      }

      if (url.endsWith('/auth/mfa')) {
        return jsonResponse({
          enabled: false,
          method: null,
          enabledAt: null,
          recoveryCodesRemaining: 0,
          pendingEnrollment: null,
        });
      }

      if (url.endsWith('/me/expediente') && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.endsWith('/me/expediente') && method === 'POST') {
        const b = body as { asignaturaId: string };
        return jsonResponse(
          { message: 'ok', asignaturaId: b.asignaturaId },
          b.asignaturaId === 'new_id' ? 201 : 200,
        );
      }
      if (url.endsWith('/me/expediente/new_id') && method === 'DELETE') {
        return jsonResponse({ message: 'deleted' }, 200);
      }

      if (url.includes('/offers/me')) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.endsWith('/offers/off_1/accept')) {
        return jsonResponse({ id: 'off_1', status: 'ACCEPTED' });
      }
      if (url.endsWith('/offers/off_1/close')) {
        return jsonResponse({ id: 'off_1', status: 'CLOSED' });
      }
      if (url.includes('/offers/off_1/messages') && method === 'GET') {
        return jsonResponse({ items: [], hasMore: false, chatOpen: true });
      }
      if (url.endsWith('/offers/off_1/messages') && method === 'POST') {
        return jsonResponse(
          { id: 'msg_1', content: 'Hola', timestamp: '2026-11-17T10:00:00Z', authorId: 'usr_1' },
          201,
        );
      }
      if (url.startsWith('http://core:3000/api/v1/offers?')) {
        return jsonResponse({ items: [], nextCursor: 'cur_off' });
      }

      if (url.endsWith('/notifications/unread-count')) {
        return jsonResponse({ count: 3 });
      }
      if (url.startsWith('http://core:3000/api/v1/notifications?') && method === 'GET') {
        return jsonResponse(
          [{ id: 'n1', asunto: 'Hola', contenido: 'Cuerpo', isRead: false, timestamp: 't' }],
          200,
          { 'X-Next-Cursor': 'cur_notif_2' },
        );
      }
      if (url.endsWith('/notifications/n1/read') || url.endsWith('/notifications/read-all')) {
        return jsonResponse({ message: 'ok' }, 200);
      }

      if (url.endsWith('/me/notification-preferences')) {
        return jsonResponse({
          email: { enabled: true, editable: false },
          telegram: { enabled: false, linked: true, chatMessages: true },
          web: { enabled: true },
        });
      }

      return jsonResponse({}, 404);
    });

    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('all'));

    // Catálogo searchSubjects (legacy array + paginado futuro)
    const legacyPage = await client.searchSubjects({
      q: 'alg',
      cursoId: 'cur_2',
      limit: 1,
      offset: 1,
    });
    expect(legacyPage).toEqual({
      items: [{ id: 'a3', codigo: 'G3', nombre: 'S3', cursoId: 'cur_2' }],
      total: 2,
    });

    const ep16Page = await client.searchSubjects({ q: 'pag' });
    expect(ep16Page.total).toBe(1);

    // MFA + Expediente (201 created vs 200 idempotent)
    expect((await client.getMfaStatus(TG.externalUserId)).enabled).toBe(false);
    expect(await client.getExpediente(TG.externalUserId)).toEqual([]);
    expect(await client.addToExpediente(TG.externalUserId, 'new_id', { updateId: 1 })).toEqual({
      created: true,
    });
    expect(await client.addToExpediente(TG.externalUserId, 'existing_id')).toEqual({
      created: false,
    });
    await expect(client.removeFromExpediente(TG.externalUserId, 'new_id')).resolves.toBeUndefined();

    // Ofertas & Chat
    const searchRes = await client.searchOffers(TG.externalUserId, {
      asignaturaId: 'a1',
      grupoActualId: 'g1',
      grupoDeseadoId: 'g2',
      limit: 5,
    });
    expect(searchRes.nextCursor).toBe('cur_off');

    await client.listMyOffers(TG.externalUserId, {
      status: ['OPEN', 'ACCEPTED'],
      role: 'creator',
      limit: 10,
    });
    const listMyReq = requests.find((r) => r.url.includes('/offers/me'));
    expect(listMyReq?.url).toContain('status=OPEN%2CACCEPTED');
    expect(listMyReq?.url).toContain('role=creator');

    await client.acceptOffer(TG.externalUserId, 'off_1', { updateId: 77 });
    const acceptReq = requests.find((r) => r.url.endsWith('/offers/off_1/accept'));
    expect(acceptReq?.headers['Content-Type']).toBeUndefined();
    expect(acceptReq?.headers['Idempotency-Key']).toBe('tg:77');

    expect((await client.closeOffer(TG.externalUserId, 'off_1')).status).toBe('CLOSED');

    await client.getOfferMessages(TG.externalUserId, 'off_1', { limit: 20, before: 'm9' });
    expect(
      (await client.sendOfferMessage(TG.externalUserId, 'off_1', 'Hola', { updateId: 88 })).id,
    ).toBe('msg_1');

    // Notificaciones & Preferencias
    const notifs = await client.getNotifications(TG.externalUserId, { unread: true, limit: 10 });
    expect(notifs.nextCursor).toBe('cur_notif_2');
    expect(notifs.items).toHaveLength(1);

    expect(await client.getUnreadNotificationsCount(TG.externalUserId)).toBe(3);
    await client.markNotificationRead(TG.externalUserId, 'n1');
    await client.markAllNotificationsRead(TG.externalUserId);

    const prefs = await client.getNotificationPreferences(TG.externalUserId);
    expect(prefs.telegram.linked).toBe(true);

    await client.updateNotificationPreferences(TG.externalUserId, { enabled: false });
    const patchPrefsReq = requests.find(
      (r) => r.method === 'PATCH' && r.url.endsWith('/me/notification-preferences'),
    );
    expect(patchPrefsReq?.body).toEqual({ telegram: { enabled: false } });
  });

  it('mapea fallos de red, timeouts, 204 No Content y errores de negocio del Core a CoreApiError', async () => {
    let mode: 'network' | 'timeout' | 'conflict' | 'no_content' = 'conflict';

    const { client, sessionManager } = createHarness((url, init) => {
      if (mode === 'network') {
        throw new TypeError('fetch failed');
      }
      if (mode === 'timeout') {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (mode === 'no_content' && url.endsWith('/me/expediente/asig_1')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/offers/off_closed/close') && init?.method === 'PATCH') {
        return jsonResponse(
          {
            error: 'La oferta ya está cerrada',
            code: 'OFFER_ALREADY_CLOSED',
            requestId: '01JREQFROMCORE',
          },
          409,
        );
      }
      return jsonResponse({}, 404);
    });

    await sessionManager.saveIssuedSession(TG, makeIssuedPayload('err'));

    await expect(client.closeOffer(TG.externalUserId, 'off_closed')).rejects.toMatchObject({
      name: 'CoreApiError',
      status: 409,
      code: 'OFFER_ALREADY_CLOSED',
      requestId: '01JREQFROMCORE',
    });

    mode = 'no_content';
    await expect(client.removeFromExpediente(TG.externalUserId, 'asig_1')).resolves.toBeUndefined();

    mode = 'network';
    await expect(client.listCareers()).rejects.toMatchObject({
      status: 503,
      code: 'CORE_UNAVAILABLE',
    });

    mode = 'timeout';
    await expect(client.listCareers()).rejects.toMatchObject({
      status: 504,
      code: 'CORE_TIMEOUT',
    });
  });
});
