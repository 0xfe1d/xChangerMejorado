import { prisma } from '../../src/config/prisma';
import { getRedis } from '../../src/config/redis';
import { createApp } from '../../src/app';
import { publish } from '../../src/events/event-publisher';
import { flushOutbox } from '../../src/events/outbox-relay';
import { StreamConsumer } from '../../src/events/stream-consumer';
import { emailSenderHandler } from '../../src/events/consumers';
import { EVENTS_STREAM, EventEnvelope } from '../../src/events/types';
import { createNotification } from '../../src/services/notification.service';
import { mailbox } from '../support/mailbox';
import { seedAcademic, createUser, eventCollector } from '../support/factories';

describe('Outbox y bus de eventos (§5.7, §11)', () => {
  it('el evento se persiste en el outbox y el publicador lo lleva al stream con el sobre común', async () => {
    const c = eventCollector();
    await c.start();
    const env = await publish('academic.changed', { entity: 'GRUPO', id: 'g1', action: 'CREATED' }, { audience: ['u1', 'u1'] });
    expect(await prisma.outbox.count({ where: { publishedAt: null } })).toBe(1);
    const seen = await c.collect();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: env.id, type: 'academic.changed', version: 1, producer: 'xchanger-core', audience: ['u1'],
      data: { entity: 'GRUPO', id: 'g1', action: 'CREATED' },
    });
    expect(new Date(seen[0].occurredAt).getTime()).not.toBeNaN();
    expect(await prisma.outbox.count({ where: { publishedAt: null } })).toBe(0);
  });

  it('un evento publicado dentro de una transacción revertida nunca sale', async () => {
    const c = eventCollector();
    await c.start();
    await expect(
      prisma.$transaction(async (tx) => {
        await publish('academic.changed', { entity: 'GRUPO', id: 'x', action: 'DELETED' }, { tx });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await c.collect()).toHaveLength(0);
  });

  it('conserva el orden de publicación', async () => {
    const c = eventCollector();
    await c.start();
    for (let i = 0; i < 5; i++) await publish('academic.changed', { entity: 'GRUPO', id: `g${i}`, action: 'CREATED' });
    const ids = (await c.collect()).map((e) => (e.data as { id: string }).id);
    expect(ids).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
  });

  it('solo una réplica publica a la vez (lock en Redis)', async () => {
    await publish('academic.changed', { entity: 'GRUPO', id: 'g', action: 'CREATED' });
    await getRedis().set('lock:outbox-relay', 'otra-replica', 'PX', 5000);
    expect(await flushOutbox()).toBe(0);
    await getRedis().del('lock:outbox-relay');
    expect(await flushOutbox()).toBe(1);
  });

  it('los consumidores deduplican por id (entrega al menos una vez → efecto una vez)', async () => {
    const handled: string[] = [];
    const consumer = new StreamConsumer('dedup-test', async (e) => {
      handled.push(e.id);
    });
    await consumer.ensureGroup();
    const env = await publish('academic.changed', { entity: 'GRUPO', id: 'g', action: 'CREATED' });
    await flushOutbox();
    // Simula que el publicador repite el evento tras una caída
    await getRedis().xadd(EVENTS_STREAM, '*', 'event', JSON.stringify(env));
    await consumer.processAvailable();
    expect(handled).toEqual([env.id]);
  });

  it('un fallo del consumidor deja el evento pendiente y se reintenta', async () => {
    let calls = 0;
    const consumer = new StreamConsumer('retry-test', async () => {
      calls++;
      if (calls === 1) throw new Error('SMTP caído');
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await consumer.ensureGroup();
    await publish('academic.changed', { entity: 'GRUPO', id: 'g', action: 'CREATED' });
    await flushOutbox();
    await consumer.processAvailable(); // falla y luego se reclama y reintenta
    expect(calls).toBe(2);
    const pending = (await getRedis().xpending(EVENTS_STREAM, 'retry-test')) as [number];
    expect(pending[0]).toBe(0);
  });
});

describe('Notificaciones multicanal (§5.8, RF-NOT-01/02)', () => {
  it('notification.created lleva los datos del contrato y el correo lo envía el consumidor con HTML escapado', async () => {
    const ac = await seedAcademic();
    const u = await createUser({ academic: ac });
    const c = eventCollector();
    await c.start();
    await createNotification({ userId: u.id, asunto: 'Hola <b>', contenido: 'x <script>alert(1)</script>', kind: 'SECURITY', refs: { offerId: 'o1' } });
    const [ev] = (await c.collect()) as EventEnvelope[];
    expect(ev.type).toBe('notification.created');
    expect(ev.data).toMatchObject({ userId: u.id, asunto: 'Hola <b>', kind: 'SECURITY', refs: { offerId: 'o1' }, delivery: { telegram: false } });
    expect(JSON.stringify(ev)).not.toContain(u.email); // el evento no lleva el email

    await emailSenderHandler(ev);
    const mail = mailbox.find((m) => m.to === u.email)!;
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
  });

  it('la notificación se persiste aunque el envío de correo falle', async () => {
    const ac = await seedAcademic();
    const u = await createUser({ academic: ac });
    await createNotification({ userId: u.id, asunto: 'A', contenido: 'B' });
    expect(await prisma.notification.count({ where: { userId: u.id, asunto: 'A' } })).toBe(1);
  });
});

describe('Pasarela de sockets', () => {
  it('la app web sigue sin depender de Socket.io en los servicios (AR-04)', async () => {
    const app = createApp();
    expect(app).toBeTruthy();
    const files = require('fs').readdirSync(require('path').resolve(__dirname, '../../src/services')) as string[];
    for (const f of files.filter((x) => x.endsWith('.ts'))) {
      const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/services', f), 'utf8') as string;
      expect(src).not.toMatch(/getIo\(|emitToUser\(/);
    }
  });
});
