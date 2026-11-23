import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import * as dbConfig from '../src/back/config/db';
import * as redisConfig from '../src/back/config/redis';
import { HttpCoreClient } from '../src/back/core/http-core.client';
import { BotHttpServer, TelegramUpdate } from '../src/back/http/webhook-server';
import { MockCoreClient } from '../src/back/mocks/mock-core.client';
import { MemoryCallbackStore, MemoryStateStore } from '../src/back/state/memory-stores';
import {
  RedisCallbackStore,
  RedisDedupStore,
  RedisLike,
  RedisPendingLinkStore,
  RedisStateStore,
} from '../src/back/storage/redis-stores';
import { OutboundQueue, TelegramRateLimitError } from '../src/back/telegram/outbound-queue';
import { createBackServices } from '../src/index';

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
}

describe('Bloque 5: OutboundQueue, BotHttpServer y cableado en index.ts', () => {
  describe('OutboundQueue (rate limit global / por chat y retry 429)', () => {
    it('espacia envíos a 1 msg/s por chat sin bloquear otros chats y respeta límite global', async () => {
      let virtualNow = 10_000;
      const sleeps: number[] = [];
      const sentLog: Array<{ tag: string; at: number }> = [];

      const queue = new OutboundQueue({
        perChatIntervalMs: 1_000,
        globalMaxPerSec: 3,
        nowMs: () => virtualNow,
        sleepFn: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
      });

      // 1. Mismo chat ("chat_1"): el 2º envío espera 1000 ms; chat distinto ("chat_2") sale en paralelo en t=10_000
      await Promise.all([
        queue.enqueue('chat_1', async () => {
          sentLog.push({ tag: 'c1_a', at: virtualNow });
        }),
        queue.enqueue('chat_2', async () => {
          sentLog.push({ tag: 'c2_a', at: virtualNow });
        }),
        queue.enqueue('chat_1', async () => {
          sentLog.push({ tag: 'c1_b', at: virtualNow });
        }),
      ]);

      const c1A = sentLog.find((e) => e.tag === 'c1_a')!.at;
      const c2A = sentLog.find((e) => e.tag === 'c2_a')!.at;
      const c1B = sentLog.find((e) => e.tag === 'c1_b')!.at;

      expect(c1A).toBe(10_000);
      expect(c2A).toBe(10_000);
      expect(c1B - c1A).toBeGreaterThanOrEqual(1_000);

      // 2. Límite global (3 msg/s): al mandar a 4 chats distintos de golpe, el 4º espera a que venza la ventana de 1s
      virtualNow = 20_000;
      sentLog.length = 0;

      await Promise.all([
        queue.enqueue('a', async () => {
          sentLog.push({ tag: 'a', at: virtualNow });
        }),
        queue.enqueue('b', async () => {
          sentLog.push({ tag: 'b', at: virtualNow });
        }),
        queue.enqueue('c', async () => {
          sentLog.push({ tag: 'c', at: virtualNow });
        }),
        queue.enqueue('d', async () => {
          sentLog.push({ tag: 'd', at: virtualNow });
        }),
      ]);

      expect(sentLog.filter((e) => e.at === 20_000)).toHaveLength(3);
      expect(sentLog.find((e) => e.tag === 'd')!.at).toBeGreaterThanOrEqual(21_000);
      expect(sleeps.some((s) => s >= 1_000)).toBe(true);
    });

    it('reintenta tras 429 usando retry_after en sendMessage y deleteMessage (RF-TGB-13)', async () => {
      let virtualNow = 1_000;
      const sleeps: number[] = [];
      let callCount = 0;

      const fetchMock: jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>> = jest.fn(
        async (input, init) => {
          callCount += 1;
          const url = typeof input === 'string' ? input : input.toString();

          if (url.endsWith('/sendMessage') && callCount === 1) {
            return new Response(
              JSON.stringify({
                ok: false,
                error_code: 429,
                description: 'Too Many Requests: retry after 3',
                parameters: { retry_after: 3 },
              }),
              { status: 429, headers: { 'Content-Type': 'application/json' } },
            );
          }

          return new Response(
            JSON.stringify({ ok: true, result: { method: url, body: JSON.parse(String(init?.body)) } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      );

      const queue = new OutboundQueue({
        botToken: '123:test-token',
        apiBaseUrl: 'https://telegram.test',
        nowMs: () => virtualNow,
        sleepFn: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      const sendRes = (await queue.sendMessage('551', 'Tu código')) as {
        method: string;
        body: { chat_id: string; text: string };
      };
      expect(sendRes.body).toEqual({ chat_id: '551', text: 'Tu código' });
      expect(callCount).toBe(2);
      expect(sleeps).toContain(3_000);

      // deleteMessage funciona y vuelve a esperar el intervalo por chat (1000 ms)
      const beforeDel = virtualNow;
      await queue.deleteMessage('551', 99);
      expect(virtualNow - beforeDel).toBeGreaterThanOrEqual(1_000);
      expect(callCount).toBe(3);

      // Si supera maxRetries con TelegramRateLimitError, propaga el error
      const failQueue = new OutboundQueue({
        maxRetries: 1,
        nowMs: () => virtualNow,
        sleepFn: async (ms) => {
          virtualNow += ms;
        },
      });
      await expect(
        failQueue.enqueue('552', async () => {
          throw new TelegramRateLimitError(2);
        }),
      ).rejects.toBeInstanceOf(TelegramRateLimitError);
    });
  });

async function invokeHttp(
  server: BotHttpServer,
  opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; json: unknown }> {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  let status = 200;
  let rawOut = '';
  const res = {
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) rawOut += chunk.toString();
      res.writableEnded = true;
      return res;
    },
  };

  const pending = server.handleRequest(req, res as unknown as ServerResponse);
  if (opts.body !== undefined) {
    req.write(opts.body);
  }
  req.end();
  await pending;

  return { status, json: rawOut ? JSON.parse(rawOut) : undefined };
}

  describe('BotHttpServer (POST /telegram/webhook + GET /healthz)', () => {
    it('valida secret token, responde 200 inmediato, deduplica update_id y rechaza > maxBodyBytes', async () => {
      const redis = new FakeRedis();
      const dedupStore = new RedisDedupStore(redis);
      const processed: TelegramUpdate[] = [];
      let releaseAsyncTask!: () => void;

      const server = new BotHttpServer({
        webhookSecret: 'super-secret-webhook',
        dedupStore,
        maxBodyBytes: 512,
        onUpdate: async (update) => {
          if (update.update_id === 1001) {
            await new Promise<void>((resolve) => {
              releaseAsyncTask = resolve;
            });
          }
          processed.push(update);
        },
      });

      const sampleUpdate: TelegramUpdate = {
        update_id: 1001,
        message: {
          message_id: 1,
          chat: { id: 551, type: 'private' },
          from: { id: 551, first_name: 'Ana' },
          text: '/start',
        },
      };

      // 1. Sin cabecera o secreta inválida -> 401
      const unauth = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleUpdate),
      });
      expect(unauth.status).toBe(401);

      const wrongSecret = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'incorrecto',
        },
        body: JSON.stringify(sampleUpdate),
      });
      expect(wrongSecret.status).toBe(401);
      expect(processed).toHaveLength(0);

      // 2. Secreto válido -> devuelve 200 ANTES de que termine la tarea en segundo plano
      const okRes = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook',
        },
        body: JSON.stringify(sampleUpdate),
      });
      expect(okRes.status).toBe(200);
      expect(okRes.json).toEqual({ ok: true });
      expect(processed).toHaveLength(0); // Sigue ejecutándose asíncronamente

      releaseAsyncTask();
      await server.drain();
      expect(processed).toHaveLength(1);
      expect(redis.data.get('tg:upd:1001')?.value).toBe('1');

      // 3. Update duplicado -> 200 { ok: true, duplicate: true } sin volver a invocar onUpdate
      const dupRes = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook',
        },
        body: JSON.stringify(sampleUpdate),
      });
      expect(dupRes.status).toBe(200);
      expect(dupRes.json).toEqual({ ok: true, duplicate: true });
      expect(processed).toHaveLength(1);

      // 4. Payload sin update_id -> 400; payload > 512 bytes -> 413; ruta desconocida -> 404
      const badRes = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook',
        },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(badRes.status).toBe(400);

      const bigRes = await invokeHttp(server, {
        method: 'POST',
        url: '/telegram/webhook',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'super-secret-webhook',
        },
        body: JSON.stringify({ update_id: 99, text: 'x'.repeat(800) }),
      });
      expect(bigRes.status).toBe(413);

      const notFoundRes = await invokeHttp(server, { method: 'GET', url: '/unknown' });
      expect(notFoundRes.status).toBe(404);
      await server.close();
    });

    it('expone GET /healthz con estado ok y degraded según Redis y Core', async () => {
      let redisUp = true;
      let coreUp = true;

      const server = new BotHttpServer({
        webhookSecret: 'secret',
        onUpdate: () => undefined,
        checkRedis: async () => redisUp,
        checkCore: async () => coreUp,
        getConsumerLagMs: () => 42,
      });

      const resOk = await invokeHttp(server, { method: 'GET', url: '/healthz' });
      expect(resOk.status).toBe(200);
      expect(resOk.json).toEqual({
        status: 'ok',
        redis: 'up',
        core: 'up',
        consumerLagMs: 42,
      });

      redisUp = false;
      const resDegraded = await invokeHttp(server, { method: 'GET', url: '/healthz' });
      expect(resDegraded.status).toBe(200);
      expect(resDegraded.json).toEqual({
        status: 'degraded',
        redis: 'down',
        core: 'up',
        consumerLagMs: 42,
      });
      await server.close();
    });
  });

  describe('Cableado en src/index.ts (createBackServices)', () => {
    it('instancia modo mock con USE_MOCK_CORE=true y modo real con USE_MOCK_CORE=false', () => {
      const mockServices = createBackServices({ USE_MOCK_CORE: true });
      expect(mockServices.core).toBeInstanceOf(MockCoreClient);
      expect(mockServices.state).toBeInstanceOf(MemoryStateStore);
      expect(mockServices.callbacks).toBeInstanceOf(MemoryCallbackStore);
      expect(mockServices.outbound).toBeInstanceOf(OutboundQueue);

      const fakeRedis = new FakeRedis();
      const redisSpy = jest
        .spyOn(redisConfig, 'getRedis')
        .mockReturnValue(fakeRedis as unknown as ReturnType<typeof redisConfig.getRedis>);
      const dbSpy = jest
        .spyOn(dbConfig, 'getBotDb')
        .mockReturnValue({
          query: jest.fn(),
        } as unknown as ReturnType<typeof dbConfig.getBotDb>);

      try {
        const realServices = createBackServices({
          USE_MOCK_CORE: false,
          CORE_API_URL: 'http://backend:3000/api/v1',
          SERVICE_CLIENT_ID: 'telegram-bot',
          SERVICE_CLIENT_SECRET: 'super-secret-de-al-menos-32-caracteres-seguros',
          BOT_DATABASE_URL: 'postgresql://bot:bot@localhost:5432/bot_db',
          TOKEN_ENC_KEY: crypto.randomBytes(32).toString('base64'),
        });

        expect(realServices.core).toBeInstanceOf(HttpCoreClient);
        expect(realServices.state).toBeInstanceOf(RedisStateStore);
        expect(realServices.callbacks).toBeInstanceOf(RedisCallbackStore);
        expect(realServices.pendingLinks).toBeInstanceOf(RedisPendingLinkStore);
        expect(realServices.dedup).toBeInstanceOf(RedisDedupStore);
        expect(realServices.outbound).toBeInstanceOf(OutboundQueue);
        expect(realServices.sessionManager).toBeDefined();
        expect(realServices.catalogCache).toBeDefined();
      } finally {
        redisSpy.mockRestore();
        dbSpy.mockRestore();
      }
    });
  });
});
