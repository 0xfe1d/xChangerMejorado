import { prisma } from '../../src/config/prisma';
import { createApp } from '../../src/app';
import { seedAcademic, createUser, webAgent, Academic, eventCollector } from '../support/factories';

const app = createApp();
let ac: Academic;
beforeEach(async () => {
  ac = await seedAcademic();
});

async function createOffer(email: string, actual: string, deseado: string) {
  const agent = await webAgent(app, email);
  const res = await agent.post('/api/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: actual, grupoDeseadoId: deseado });
  return { agent, res };
}

describe('RS-04 Ofertas', () => {
  it('CA-04: B (tiene 2, desea 1) encuentra la oferta de A (tiene 1, desea 2)', async () => {
    const a = await createUser({ academic: ac });
    const b = await createUser({ academic: ac });
    const { res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    expect(res.status).toBe(201);
    const agentB = await webAgent(app, b.email);
    const found = await agentB.get(`/api/offers?asignaturaId=${ac.asignatura.id}&grupoActualId=${ac.g2.id}&grupoDeseadoId=${ac.g1.id}`).expect(200);
    expect(found.body.map((o: { id: string }) => o.id)).toEqual([res.body.id]);
    const none = await agentB.get(`/api/offers?asignaturaId=${ac.asignatura.id}&grupoActualId=${ac.g3.id}&grupoDeseadoId=${ac.g1.id}`).expect(200);
    expect(none.body).toEqual([]);
  });

  it('RF-OFE-02: grupos iguales o de otra asignatura → 400', async () => {
    const a = await createUser({ academic: ac });
    expect((await createOffer(a.email, ac.g1.id, ac.g1.id)).res.status).toBe(400);
    const other = await prisma.asignatura.create({ data: { nombre: 'Otra', codigo: `X-${Date.now()}`, cursoId: ac.curso.id } });
    const gx = await prisma.grupo.create({ data: { nombre: 'PX', asignaturaId: other.id } });
    expect((await createOffer(a.email, ac.g1.id, gx.id)).res.status).toBe(400);
  });

  it('RF-PER-03: sin expediente no se puede crear ni aceptar (409 EXPEDIENTE_REQUIRED)', async () => {
    const a = await createUser({ academic: ac, expediente: false });
    const { res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXPEDIENTE_REQUIRED');
  });

  it('RF-OFE-07: crear una oferta notifica al creador', async () => {
    const a = await createUser({ academic: ac });
    await createOffer(a.email, ac.g1.id, ac.g2.id);
    expect(await prisma.notification.count({ where: { userId: a.id, asunto: { contains: 'publicada' } } })).toBe(1);
  });

  it('RF-OFE-08: no se puede aceptar la propia oferta (400 OWN_OFFER)', async () => {
    const a = await createUser({ academic: ac });
    const { agent, res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    const r = await agent.post(`/api/offers/${res.body.id}/accept`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('OWN_OFFER');
  });

  it('CA-05: dos aceptaciones concurrentes → solo una gana; la otra recibe 409', async () => {
    const a = await createUser({ academic: ac });
    const { res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    const b = await createUser({ academic: ac });
    const c = await createUser({ academic: ac });
    const [ab, acAgent] = await Promise.all([webAgent(app, b.email), webAgent(app, c.email)]);
    const results = await Promise.all([ab.post(`/api/offers/${res.body.id}/accept`), acAgent.post(`/api/offers/${res.body.id}/accept`)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('OFFER_NOT_OPEN');
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(offer.status).toBe('ACCEPTED');
    expect([b.id, c.id]).toContain(offer.acceptedById);
  });

  it('RF-OFE-09: al aceptar se notifica a ambas partes con nombre y email de la contraparte', async () => {
    const a = await createUser({ academic: ac, name: 'Ana Creadora' });
    const b = await createUser({ academic: ac, name: 'Beto Aceptante' });
    const { res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    await (await webAgent(app, b.email)).post(`/api/offers/${res.body.id}/accept`).expect(200);
    const na = await prisma.notification.findFirstOrThrow({ where: { userId: a.id, asunto: { contains: 'aceptada' } } });
    const nb = await prisma.notification.findFirstOrThrow({ where: { userId: b.id, asunto: { contains: 'aceptada' } } });
    expect(na.contenido).toContain('Beto Aceptante');
    expect(na.contenido).toContain(b.email);
    expect(nb.contenido).toContain(a.email);
  });

  it('RF-OFE-10: creador, aceptante o admin cierran; cerrada no se reabre (409); terceros 403', async () => {
    const a = await createUser({ academic: ac });
    const intruso = await createUser({ academic: ac });
    const { agent, res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    await (await webAgent(app, intruso.email)).patch(`/api/offers/${res.body.id}/close`).expect(403);
    await agent.patch(`/api/offers/${res.body.id}/close`).expect(200);
    const again = await agent.patch(`/api/offers/${res.body.id}/close`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('OFFER_ALREADY_CLOSED');
    expect((await (await webAgent(app, (await createUser({ academic: ac })).email)).post(`/api/offers/${res.body.id}/accept`)).status).toBe(409);
  });

  it('RF-OFE-11: el panel lista ofertas propias y aceptadas, de más reciente a más antigua', async () => {
    const a = await createUser({ academic: ac });
    const b = await createUser({ academic: ac });
    const first = (await createOffer(a.email, ac.g1.id, ac.g2.id)).res.body;
    const other = (await createOffer(b.email, ac.g2.id, ac.g3.id)).res.body;
    const agentA = await webAgent(app, a.email);
    await agentA.post(`/api/offers/${other.id}/accept`).expect(200);
    const panel = await agentA.get('/api/offers/me').expect(200);
    expect(panel.body.map((o: { id: string }) => o.id)).toEqual([other.id, first.id]);
  });
});

describe('EP-C-12 / EP-C-13 paginación por cursor', () => {
  it('con limit devuelve {items, nextCursor}, excluye las propias y no repite elementos', async () => {
    const owner = await createUser({ academic: ac });
    const searcher = await createUser({ academic: ac });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await createUser({ academic: ac });
      ids.push((await createOffer(u.email, ac.g1.id, ac.g2.id)).res.body.id);
    }
    await createOffer(searcher.email, ac.g1.id, ac.g2.id); // propia: no debe salir
    void owner;
    const agent = await webAgent(app, searcher.email);
    const q = `asignaturaId=${ac.asignatura.id}&grupoActualId=${ac.g2.id}&grupoDeseadoId=${ac.g1.id}`;
    const p1 = await agent.get(`/api/v1/offers?${q}&limit=3`).expect(200);
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.items[0]).toMatchObject({ creator: { name: expect.any(String) } });
    expect(p1.body.items[0].creator.email).toBeUndefined();
    const p2 = await agent.get(`/api/v1/offers?${q}&limit=3&cursor=${p1.body.nextCursor}`).expect(200);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items].map((o: { id: string }) => o.id);
    expect(new Set(all)).toEqual(new Set(ids));
  });

  it('cursor manipulado → 400', async () => {
    const u = await createUser({ academic: ac });
    await (await webAgent(app, u.email)).get('/api/v1/offers?limit=3&cursor=basura').expect(400);
  });

  it('/offers/me admite status, role y contraparte solo si ACCEPTED', async () => {
    const a = await createUser({ academic: ac, name: 'Ana' });
    const b = await createUser({ academic: ac, name: 'Beto' });
    const o1 = (await createOffer(a.email, ac.g1.id, ac.g2.id)).res.body;
    await createOffer(a.email, ac.g2.id, ac.g3.id);
    await (await webAgent(app, b.email)).post(`/api/offers/${o1.id}/accept`).expect(200);
    const agentA = await webAgent(app, a.email);
    const acc = await agentA.get('/api/v1/offers/me?status=ACCEPTED&role=creator').expect(200);
    expect(acc.body.items).toHaveLength(1);
    expect(acc.body.items[0]).toMatchObject({ id: o1.id, isCreator: true, counterpart: { name: 'Beto' } });
    const open = await agentA.get('/api/v1/offers/me?status=OPEN').expect(200);
    expect(open.body.items[0].counterpart).toBeNull();
    await agentA.get('/api/v1/offers/me?status=RARO').expect(400);
  });

  it('EP-C-14: grupos de una asignatura sin pasar por /admin, ordenados', async () => {
    const u = await createUser({ academic: ac });
    const res = await (await webAgent(app, u.email)).get(`/api/v1/subjects/${ac.asignatura.id}/groups`).expect(200);
    expect(res.body).toEqual([
      { id: ac.g1.id, nombre: 'P1' },
      { id: ac.g2.id, nombre: 'P2' },
      { id: ac.g3.id, nombre: 'P3' },
    ]);
    await prisma.curso.update({ where: { id: ac.curso.id }, data: { deletedAt: new Date() } });
    await (await webAgent(app, u.email)).get(`/api/v1/subjects/${ac.asignatura.id}/groups`).expect(404); // ancestro eliminado
  });
});

describe('RS-05 Mensajería de ofertas', () => {
  async function acceptedOffer() {
    const a = await createUser({ academic: ac });
    const b = await createUser({ academic: ac });
    const { agent: agentA, res } = await createOffer(a.email, ac.g1.id, ac.g2.id);
    const agentB = await webAgent(app, b.email);
    await agentB.post(`/api/offers/${res.body.id}/accept`).expect(200);
    return { a, b, agentA, agentB, offerId: res.body.id as string };
  }

  it('CA-06: un mensaje queda guardado, ambos reciben notificación y se publica offer.message.created', async () => {
    const events = eventCollector();
    await events.start();
    const { a, b, agentA, offerId } = await acceptedOffer();
    const res = await agentA.post(`/api/offers/${offerId}/messages`).send({ content: '  Hola, ¿cambiamos?  ' }).expect(201);
    expect(res.body.content).toBe('Hola, ¿cambiamos?'); // RF-CHT-03: recorte lateral
    await new Promise((r) => setTimeout(r, 150));
    for (const u of [a, b]) {
      expect(await prisma.notification.count({ where: { userId: u.id, asunto: { contains: 'mensaje' } } })).toBe(1);
    }
    const seen = await events.collect();
    const ev = seen.find((e) => e.type === 'offer.message.created')!;
    expect(ev.audience.sort()).toEqual([a.id, b.id].sort());
    expect(ev.data).toMatchObject({ offerId, content: 'Hola, ¿cambiamos?', authorId: a.id });
  });

  it('RF-CHT-01/03: solo las partes; mensajes vacíos o >2000 se rechazan', async () => {
    const { agentA, offerId } = await acceptedOffer();
    await agentA.post(`/api/offers/${offerId}/messages`).send({ content: '   ' }).expect(400);
    await agentA.post(`/api/offers/${offerId}/messages`).send({ content: 'x'.repeat(2001) }).expect(400);
    const intruso = await createUser({ academic: ac });
    await (await webAgent(app, intruso.email)).post(`/api/offers/${offerId}/messages`).send({ content: 'hola' }).expect(403);
  });

  it('RF-CHT-08: un chat cerrado no acepta mensajes (409 CHAT_CLOSED) pero se lee', async () => {
    const { agentA, agentB, offerId } = await acceptedOffer();
    await agentA.post(`/api/offers/${offerId}/messages`).send({ content: 'antes' }).expect(201);
    await agentB.patch(`/api/offers/${offerId}/close`).expect(200);
    const r = await agentA.post(`/api/offers/${offerId}/messages`).send({ content: 'después' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHAT_CLOSED');
    const detail = await agentA.get(`/api/offers/${offerId}`).expect(200);
    expect(detail.body.messages.map((m: { content: string }) => m.content)).toEqual(['antes']);
  });
});
