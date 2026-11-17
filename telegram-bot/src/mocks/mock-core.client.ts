import {
  AsignaturaSearchItem,
  AsignaturaSearchPage,
  Carrera,
  ChannelAuthResult,
  ChannelChallengeResponse,
  ChannelSessionIssued,
  CoreApiError,
  CoreClient,
  Curso,
  ExpedienteItem,
  Grupo,
  LinkRequestCreated,
  MfaStatus,
  MyOfferItem,
  MyOffersPage,
  NotificationItem,
  NotificationPreferences,
  NotificationsPage,
  OfferActionResult,
  OfferMessageItem,
  OfferMessagesPage,
  OfferSearchItem,
  OfferSearchPage,
  OfferStatus,
  RequestMeta,
  SentMessageResult,
  TelegramIdentityInput,
  UserProfile,
} from '../contracts';

interface MockUserRecord {
  profile: UserProfile;
  expedienteIds: Set<string>;
  linkedTgId?: string;
}

const CAREERS: Carrera[] = [
  { id: 'car_inf', nombre: 'Grado en Ingeniería Informática' },
  { id: 'car_mat', nombre: 'Grado en Matemáticas' },
];

const COURSES: Record<string, Curso[]> = {
  car_inf: [
    { id: 'cur_inf_1', nombre: '1º' },
    { id: 'cur_inf_2', nombre: '2º' },
    { id: 'cur_inf_3', nombre: '3º' },
  ],
  car_mat: [{ id: 'cur_mat_1', nombre: '1º' }],
};

const SUBJECTS: Array<AsignaturaSearchItem & { grupos: Grupo[]; carreraId: string }> = [
  {
    id: 'asig_daw',
    codigo: 'G1234',
    nombre: 'Desarrollo de Aplicaciones Web',
    cursoId: 'cur_inf_3',
    carreraId: 'car_inf',
    grupos: [
      { id: 'grp_daw_1', nombre: 'PL1' },
      { id: 'grp_daw_2', nombre: 'PL2' },
      { id: 'grp_daw_3', nombre: 'PL3' },
    ],
  },
  {
    id: 'asig_bd',
    codigo: 'G1205',
    nombre: 'Bases de Datos',
    cursoId: 'cur_inf_2',
    carreraId: 'car_inf',
    grupos: [
      { id: 'grp_bd_1', nombre: 'PL1' },
      { id: 'grp_bd_2', nombre: 'PL2' },
    ],
  },
  {
    id: 'asig_alg',
    codigo: 'G1101',
    nombre: 'Álgebra Lineal',
    cursoId: 'cur_mat_1',
    carreraId: 'car_mat',
    grupos: [
      { id: 'grp_alg_1', nombre: 'G1' },
      { id: 'grp_alg_2', nombre: 'G2' },
    ],
  },
];

/**
 * CoreClient de mentira (en memoria) para que el Front del bot pueda construir
 * y probar todos los comandos y botones desde el día 1 sin necesitar el backend real.
 */
export class MockCoreClient implements CoreClient {
  private readonly linkedByTg = new Map<string, string>(); // externalUserId -> coreUserId
  private readonly users = new Map<string, MockUserRecord>();
  private readonly linkCodes = new Map<string, { externalUserId: string; displayName: string }>();
  private readonly offers: Array<
    OfferSearchItem & { userId: string; acceptedById: string | null; status: OfferStatus }
  > = [];
  private readonly messages = new Map<string, OfferMessageItem[]>();
  private readonly notifications = new Map<string, NotificationItem[]>();
  private readonly prefs = new Map<string, { enabled: boolean; chatMessages: boolean }>();

  constructor() {
    // Usuario de prueba para búsquedas complementarias
    this.users.set('usr_demo_otro', {
      profile: {
        id: 'usr_demo_otro',
        name: 'Carlos Gómez',
        email: 'cgomez@alumnos.unican.es',
        role: 'ESTUDIANTE',
        carreraId: 'car_inf',
        cursoId: 'cur_inf_3',
        mfaEnabled: false,
      },
      expedienteIds: new Set(['asig_daw']),
    });

    this.offers.push({
      id: 'off_demo_1',
      createdAt: new Date().toISOString(),
      status: 'OPEN',
      userId: 'usr_demo_otro',
      acceptedById: null,
      asignatura: { id: 'asig_daw', codigo: 'G1234', nombre: 'Desarrollo de Aplicaciones Web' },
      grupoActual: { id: 'grp_daw_2', nombre: 'PL2' },
      grupoDeseado: { id: 'grp_daw_1', nombre: 'PL1' },
      creator: { name: 'Carlos Gómez' },
    });
  }

  private requireUser(externalUserId: string): MockUserRecord {
    const uid = this.linkedByTg.get(externalUserId);
    const user = uid ? this.users.get(uid) : undefined;
    if (!user) throw new CoreApiError(401, 'UNAUTHORIZED', 'Debes vincular o iniciar sesión primero');
    return user;
  }

  private createDemoSession(tg: TelegramIdentityInput, userId: string, name: string): ChannelSessionIssued {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        profile: {
          id: userId,
          name,
          email: 'estudiante@alumnos.unican.es',
          role: 'ESTUDIANTE',
          carreraId: 'car_inf',
          cursoId: 'cur_inf_3',
          mfaEnabled: false,
        },
        expedienteIds: new Set(['asig_daw']),
      });
      this.notifications.set(userId, [
        {
          id: 'not_demo_1',
          asunto: 'Bienvenido a xChanger (Mock)',
          contenido: 'Esta notificación viene del modo mock para pruebas locales.',
          isRead: false,
          timestamp: new Date().toISOString(),
        },
      ]);
      this.prefs.set(userId, { enabled: true, chatMessages: true });
    }
    this.linkedByTg.set(tg.externalUserId, userId);
    const rec = this.users.get(userId)!;
    rec.linkedTgId = tg.externalUserId;

    return {
      kind: 'session',
      sessionId: `cs_mock_${tg.externalUserId}`,
      absoluteExpiresAt: new Date(Date.now() + 180 * 86400_000).toISOString(),
      user: {
        id: rec.profile.id,
        name: rec.profile.name,
        role: rec.profile.role,
        mfaEnabled: rec.profile.mfaEnabled,
        hasExpediente: rec.expedienteIds.size > 0,
      },
    };
  }

  async isLinked(externalUserId: string): Promise<boolean> {
    return this.linkedByTg.has(externalUserId);
  }

  async createLinkRequest(tg: TelegramIdentityInput): Promise<LinkRequestCreated> {
    const deviceCode = `dev_${tg.externalUserId}_${Date.now()}`;
    const userCode = 'DEMO-2345';
    this.linkCodes.set(deviceCode, { externalUserId: tg.externalUserId, displayName: tg.displayName });
    return {
      deviceCode,
      userCode,
      verificationUri: 'http://localhost:4321/vincular',
      verificationUriComplete: `http://localhost:4321/vincular?code=${userCode}`,
      expiresIn: 600,
      interval: 5,
    };
  }

  async exchangeLinkCode(tg: TelegramIdentityInput, deviceCode: string): Promise<ChannelSessionIssued> {
    if (!this.linkCodes.has(deviceCode)) {
      throw new CoreApiError(400, 'INVALID_GRANT', 'Código de dispositivo inválido');
    }
    // En mock aprobamos automáticamente al primer intento para probar el flujo rápido
    this.linkCodes.delete(deviceCode);
    return this.createDemoSession(tg, `usr_tg_${tg.externalUserId}`, tg.displayName);
  }

  async sendEmailOtp(_externalUserId: string, email: string): Promise<ChannelChallengeResponse> {
    if (!email.toLowerCase().endsWith('@alumnos.unican.es')) {
      throw new CoreApiError(400, 'INVALID_EMAIL_DOMAIN', 'El correo debe terminar en @alumnos.unican.es');
    }
    return { challengeToken: `mock_email_otp:${email.toLowerCase()}`, expiresIn: 600, codeLength: 6 };
  }

  async verifyEmailOtp(tg: TelegramIdentityInput, challengeToken: string, code: string): Promise<ChannelAuthResult> {
    if (!/^\d{6}$/.test(code)) throw new CoreApiError(400, 'INVALID_GRANT', 'Código incorrecto (usa 6 dígitos)');
    const email = challengeToken.split(':')[1] ?? 'estudiante@alumnos.unican.es';
    const session = this.createDemoSession(tg, `usr_tg_${tg.externalUserId}`, tg.displayName);
    this.users.get(session.user.id)!.profile.email = email;
    return session;
  }

  async registerFromTelegram(input: {
    externalUserId: string;
    name: string;
    email: string;
    carreraId: string;
    cursoId: string;
    acceptTerms: true;
  }): Promise<ChannelChallengeResponse> {
    if (!input.email.toLowerCase().endsWith('@alumnos.unican.es')) {
      throw new CoreApiError(400, 'INVALID_EMAIL_DOMAIN', 'El correo debe terminar en @alumnos.unican.es');
    }
    return { challengeToken: `mock_reg:${input.email}:${input.name}`, expiresIn: 1800, codeLength: 6 };
  }

  async verifyRegistrationOtp(
    tg: TelegramIdentityInput,
    challengeToken: string,
    code: string,
  ): Promise<ChannelSessionIssued> {
    if (!/^\d{6}$/.test(code)) throw new CoreApiError(400, 'INVALID_GRANT', 'Código incorrecto');
    const [, email, name] = challengeToken.split(':');
    const session = this.createDemoSession(tg, `usr_tg_${tg.externalUserId}`, name || tg.displayName);
    this.users.get(session.user.id)!.profile.email = email || 'nuevo@alumnos.unican.es';
    return session;
  }

  async verifyMfa(
    tg: TelegramIdentityInput,
    _challengeToken: string,
    factor: { code?: string; recoveryCode?: string },
  ): Promise<ChannelSessionIssued> {
    if (!factor.code && !factor.recoveryCode) throw new CoreApiError(400, 'VALIDATION_ERROR', 'Código requerido');
    return this.createDemoSession(tg, `usr_tg_${tg.externalUserId}`, tg.displayName);
  }

  async revoke(externalUserId: string): Promise<void> {
    this.linkedByTg.delete(externalUserId);
  }

  async getProfile(externalUserId: string): Promise<UserProfile> {
    return this.requireUser(externalUserId).profile;
  }

  async getMfaStatus(externalUserId: string): Promise<MfaStatus> {
    const user = this.requireUser(externalUserId);
    return {
      enabled: user.profile.mfaEnabled,
      method: user.profile.mfaEnabled ? 'xotp' : null,
      enabledAt: null,
      recoveryCodesRemaining: user.profile.mfaEnabled ? 10 : 0,
      pendingEnrollment: null,
    };
  }

  async listCareers(q?: string): Promise<Carrera[]> {
    if (!q) return CAREERS;
    const term = q.toLowerCase();
    return CAREERS.filter((c) => c.nombre.toLowerCase().includes(term));
  }

  async listCourses(carreraId: string): Promise<Curso[]> {
    return COURSES[carreraId] ?? [];
  }

  async searchSubjects(params: {
    q: string;
    carreraId?: string;
    cursoId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AsignaturaSearchPage> {
    const term = params.q.trim().toLowerCase();
    const filtered = SUBJECTS.filter(
      (s) =>
        (!params.carreraId || s.carreraId === params.carreraId) &&
        (!params.cursoId || s.cursoId === params.cursoId) &&
        (!term || s.nombre.toLowerCase().includes(term) || s.codigo.toLowerCase().includes(term)),
    );
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 10;
    return {
      items: filtered.slice(offset, offset + limit).map(({ id, codigo, nombre, cursoId }) => ({
        id,
        codigo,
        nombre,
        cursoId,
      })),
      total: filtered.length,
    };
  }

  async getExpediente(externalUserId: string): Promise<ExpedienteItem[]> {
    const user = this.requireUser(externalUserId);
    return SUBJECTS.filter((s) => user.expedienteIds.has(s.id)).map((s) => ({
      id: s.id,
      codigo: s.codigo,
      nombre: s.nombre,
      cursoId: s.cursoId,
      grupos: s.grupos,
      curso: {
        id: s.cursoId,
        nombre: COURSES[s.carreraId]?.find((c) => c.id === s.cursoId)?.nombre ?? '1º',
        carreraId: s.carreraId,
        carrera: { nombre: CAREERS.find((c) => c.id === s.carreraId)?.nombre ?? 'Carrera' },
      },
    }));
  }

  async addToExpediente(externalUserId: string, asignaturaId: string): Promise<{ created: boolean }> {
    const user = this.requireUser(externalUserId);
    if (!SUBJECTS.some((s) => s.id === asignaturaId)) throw new CoreApiError(404, 'NOT_FOUND', 'Asignatura no encontrada');
    const created = !user.expedienteIds.has(asignaturaId);
    user.expedienteIds.add(asignaturaId);
    return { created };
  }

  async removeFromExpediente(externalUserId: string, asignaturaId: string): Promise<void> {
    const user = this.requireUser(externalUserId);
    user.expedienteIds.delete(asignaturaId);
  }

  async listSubjectGroups(externalUserId: string, asignaturaId: string): Promise<Grupo[]> {
    this.requireUser(externalUserId);
    const s = SUBJECTS.find((item) => item.id === asignaturaId);
    if (!s) throw new CoreApiError(404, 'NOT_FOUND', 'Asignatura no encontrada');
    return s.grupos;
  }

  async searchOffers(
    externalUserId: string,
    params: { asignaturaId: string; grupoActualId: string; grupoDeseadoId: string; limit?: number },
  ): Promise<OfferSearchPage> {
    const user = this.requireUser(externalUserId);
    const items = this.offers
      .filter(
        (o) =>
          o.status === 'OPEN' &&
          o.userId !== user.profile.id &&
          o.asignatura.id === params.asignaturaId &&
          o.grupoActual.id === params.grupoDeseadoId &&
          o.grupoDeseado.id === params.grupoActualId,
      )
      .slice(0, params.limit ?? 10);
    return { items, nextCursor: null };
  }

  async listMyOffers(
    externalUserId: string,
    params?: { status?: OfferStatus[]; role?: 'creator' | 'acceptor' | 'any' },
  ): Promise<MyOffersPage> {
    const user = this.requireUser(externalUserId);
    const uid = user.profile.id;
    const role = params?.role ?? 'any';
    const items: MyOfferItem[] = this.offers
      .filter((o) => {
        const isCreator = o.userId === uid;
        const isAcceptor = o.acceptedById === uid;
        if (role === 'creator' && !isCreator) return false;
        if (role === 'acceptor' && !isAcceptor) return false;
        if (role === 'any' && !isCreator && !isAcceptor) return false;
        if (params?.status?.length && !params.status.includes(o.status)) return false;
        return true;
      })
      .map((o) => ({
        id: o.id,
        createdAt: o.createdAt,
        status: o.status,
        asignatura: o.asignatura,
        grupoActual: o.grupoActual,
        grupoDeseado: o.grupoDeseado,
        isCreator: o.userId === uid,
        counterpart: o.status === 'ACCEPTED' ? { name: o.userId === uid ? 'Contraparte Demo' : o.creator.name } : null,
      }));
    return { items, nextCursor: null };
  }

  async createOffer(
    externalUserId: string,
    input: { asignaturaId: string; grupoActualId: string; grupoDeseadoId: string },
    _meta?: RequestMeta,
  ): Promise<OfferActionResult> {
    const user = this.requireUser(externalUserId);
    if (user.expedienteIds.size === 0) {
      throw new CoreApiError(409, 'EXPEDIENTE_REQUIRED', 'Añade al menos una asignatura a tu expediente');
    }
    const s = SUBJECTS.find((x) => x.id === input.asignaturaId);
    const ga = s?.grupos.find((g) => g.id === input.grupoActualId);
    const gd = s?.grupos.find((g) => g.id === input.grupoDeseadoId);
    if (!s || !ga || !gd || ga.id === gd.id) {
      throw new CoreApiError(400, 'VALIDATION_ERROR', 'Grupos o asignatura no válidos');
    }
    const created = {
      id: `off_${Date.now()}`,
      createdAt: new Date().toISOString(),
      status: 'OPEN' as OfferStatus,
      userId: user.profile.id,
      acceptedById: null,
      asignatura: { id: s.id, codigo: s.codigo, nombre: s.nombre },
      grupoActual: ga,
      grupoDeseado: gd,
      creator: { name: user.profile.name },
    };
    this.offers.unshift(created);
    return created;
  }

  async acceptOffer(externalUserId: string, offerId: string): Promise<OfferActionResult> {
    const user = this.requireUser(externalUserId);
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) throw new CoreApiError(404, 'NOT_FOUND', 'Oferta no encontrada');
    if (offer.userId === user.profile.id) throw new CoreApiError(400, 'OWN_OFFER', 'No puedes aceptar tu propia oferta');
    if (offer.status !== 'OPEN') throw new CoreApiError(409, 'OFFER_NOT_OPEN', 'Esta oferta ya no está abierta');
    offer.status = 'ACCEPTED';
    offer.acceptedById = user.profile.id;
    return offer;
  }

  async closeOffer(externalUserId: string, offerId: string): Promise<OfferActionResult> {
    const user = this.requireUser(externalUserId);
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) throw new CoreApiError(404, 'NOT_FOUND', 'Oferta no encontrada');
    if (offer.userId !== user.profile.id && offer.acceptedById !== user.profile.id) {
      throw new CoreApiError(403, 'FORBIDDEN', 'No eres parte de esta oferta');
    }
    if (offer.status === 'CLOSED') throw new CoreApiError(409, 'OFFER_ALREADY_CLOSED', 'La oferta ya estaba cerrada');
    offer.status = 'CLOSED';
    return offer;
  }

  async getOfferMessages(externalUserId: string, offerId: string): Promise<OfferMessagesPage> {
    const user = this.requireUser(externalUserId);
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) throw new CoreApiError(404, 'NOT_FOUND', 'Oferta no encontrada');
    const items = (this.messages.get(offerId) ?? []).map((m) => ({ ...m, isMine: m.authorId === user.profile.id }));
    return { items, hasMore: false, chatOpen: offer.status === 'ACCEPTED' };
  }

  async sendOfferMessage(externalUserId: string, offerId: string, content: string): Promise<SentMessageResult> {
    const user = this.requireUser(externalUserId);
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) throw new CoreApiError(404, 'NOT_FOUND', 'Oferta no encontrada');
    if (offer.status !== 'ACCEPTED') throw new CoreApiError(409, 'CHAT_CLOSED', 'El chat está cerrado');
    const text = content.trim();
    if (!text || text.length > 2000) throw new CoreApiError(400, 'VALIDATION_ERROR', 'Mensaje entre 1 y 2000 caracteres');

    const msg: OfferMessageItem = {
      id: `msg_${Date.now()}`,
      authorId: user.profile.id,
      authorName: user.profile.name,
      content: text,
      timestamp: new Date().toISOString(),
      isMine: true,
    };
    const list = this.messages.get(offerId) ?? [];
    list.push(msg);
    this.messages.set(offerId, list);
    return { id: msg.id, content: msg.content, timestamp: msg.timestamp, authorId: msg.authorId };
  }

  async getNotifications(externalUserId: string, params?: { unread?: boolean }): Promise<NotificationsPage> {
    const user = this.requireUser(externalUserId);
    const all = this.notifications.get(user.profile.id) ?? [];
    return { items: params?.unread ? all.filter((n) => !n.isRead) : all, nextCursor: null };
  }

  async getUnreadNotificationsCount(externalUserId: string): Promise<number> {
    const user = this.requireUser(externalUserId);
    return (this.notifications.get(user.profile.id) ?? []).filter((n) => !n.isRead).length;
  }

  async markNotificationRead(externalUserId: string, notificationId: string): Promise<void> {
    const user = this.requireUser(externalUserId);
    const item = (this.notifications.get(user.profile.id) ?? []).find((n) => n.id === notificationId);
    if (item) item.isRead = true;
  }

  async markAllNotificationsRead(externalUserId: string): Promise<void> {
    const user = this.requireUser(externalUserId);
    for (const n of this.notifications.get(user.profile.id) ?? []) n.isRead = true;
  }

  async getNotificationPreferences(externalUserId: string): Promise<NotificationPreferences> {
    const user = this.requireUser(externalUserId);
    const p = this.prefs.get(user.profile.id) ?? { enabled: true, chatMessages: true };
    return {
      email: { enabled: true, editable: false },
      telegram: { enabled: p.enabled, linked: true, chatMessages: p.chatMessages },
      web: { enabled: true },
    };
  }

  async updateNotificationPreferences(
    externalUserId: string,
    patch: { enabled?: boolean; chatMessages?: boolean },
  ): Promise<NotificationPreferences> {
    const user = this.requireUser(externalUserId);
    const current = this.prefs.get(user.profile.id) ?? { enabled: true, chatMessages: true };
    this.prefs.set(user.profile.id, {
      enabled: patch.enabled ?? current.enabled,
      chatMessages: patch.chatMessages ?? current.chatMessages,
    });
    return this.getNotificationPreferences(externalUserId);
  }
}

