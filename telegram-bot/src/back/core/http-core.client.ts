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
  MyOffersPage,
  NotificationItem,
  NotificationPreferences,
  NotificationsPage,
  OfferActionResult,
  OfferMessagesPage,
  OfferSearchPage,
  OfferStatus,
  RequestMeta,
  SentMessageResult,
  TelegramIdentityInput,
  UserProfile,
} from '../../contracts';
import { RedisCatalogCache } from './catalog-cache';
import { CoreHttpConfig, CoreHttpTransport } from './core-http';
import { ChannelSessionManager, CoreIssuedSessionPayload } from './session-manager';

const CHANNEL = 'telegram' as const;

interface CoreMfaRequiredPayload {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
  methods: Array<'xotp' | 'recovery_code'>;
}

type LegacySubjectItem = AsignaturaSearchItem & {
  carreraId?: string;
  curso?: { carreraId?: string };
};

export interface HttpCoreClientConfig extends CoreHttpConfig {
  catalogCache?: RedisCatalogCache;
}

function adaptLegacySubjects(
  raw: LegacySubjectItem[],
  params: { carreraId?: string; cursoId?: string; limit?: number; offset?: number },
): AsignaturaSearchPage {
  const filtered = raw.filter((item) => {
    const careerId = item.carreraId ?? item.curso?.carreraId;
    if (params.carreraId && careerId && careerId !== params.carreraId) return false;
    if (params.cursoId && item.cursoId !== params.cursoId) return false;
    return true;
  });

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 10;
  return {
    items: filtered
      .slice(offset, offset + limit)
      .map(({ id, codigo, nombre, cursoId }) => ({ id, codigo, nombre, cursoId })),
    total: filtered.length,
  };
}

/**
 * Implementación HTTP de los 31 métodos de `CoreClient` contra la API `/api/v1` del Core.
 * Delega cabeceras, reintentos `401` e idempotencia en `CoreHttpTransport` y cachea catálogo/grupos.
 */
export class HttpCoreClient implements CoreClient {
  private readonly http: CoreHttpTransport;
  private readonly sessionManager: ChannelSessionManager;
  private readonly catalogCache?: RedisCatalogCache;

  constructor(config: HttpCoreClientConfig) {
    this.http = new CoreHttpTransport(config);
    this.sessionManager = config.sessionManager;
    this.catalogCache = config.catalogCache;
  }

  private async issueChannelSession(
    tg: TelegramIdentityInput,
    body: Record<string, unknown>,
  ): Promise<ChannelSessionIssued> {
    const { data } = await this.http.serviceRequest<CoreIssuedSessionPayload>(
      'POST',
      '/channel-auth/token',
      { body: { channel: CHANNEL, externalUserId: tg.externalUserId, ...body } },
    );
    return this.sessionManager.saveIssuedSession(tg, data);
  }

  // ── Sesión y vinculación ──────────────────────────────────────

  isLinked(externalUserId: string): Promise<boolean> {
    return this.sessionManager.isLinked(externalUserId);
  }

  async createLinkRequest(tg: TelegramIdentityInput): Promise<LinkRequestCreated> {
    const { data } = await this.http.serviceRequest<LinkRequestCreated>(
      'POST',
      '/channel-auth/link-requests',
      {
        body: {
          channel: CHANNEL,
          externalUserId: tg.externalUserId,
          displayName: tg.displayName,
          ...(tg.username ? { username: tg.username } : {}),
        },
      },
    );
    return data;
  }

  exchangeLinkCode(tg: TelegramIdentityInput, deviceCode: string): Promise<ChannelSessionIssued> {
    return this.issueChannelSession(tg, { grant_type: 'link_code', deviceCode });
  }

  async sendEmailOtp(externalUserId: string, email: string): Promise<ChannelChallengeResponse> {
    const { data } = await this.http.serviceRequest<ChannelChallengeResponse>(
      'POST',
      '/channel-auth/email-otp',
      { body: { channel: CHANNEL, externalUserId, email } },
    );
    return data;
  }

  async verifyEmailOtp(
    tg: TelegramIdentityInput,
    challengeToken: string,
    code: string,
  ): Promise<ChannelAuthResult> {
    const { data } = await this.http.serviceRequest<
      CoreIssuedSessionPayload | CoreMfaRequiredPayload
    >('POST', '/channel-auth/token', {
      body: {
        grant_type: 'email_otp',
        channel: CHANNEL,
        externalUserId: tg.externalUserId,
        challengeToken,
        code,
      },
    });

    if ('mfaRequired' in data && data.mfaRequired) {
      return {
        kind: 'mfa_required',
        challengeToken: data.challengeToken,
        expiresIn: data.expiresIn,
        methods: data.methods,
      };
    }

    return this.sessionManager.saveIssuedSession(tg, data as CoreIssuedSessionPayload);
  }

  async registerFromTelegram(
    input: {
      externalUserId: string;
      name: string;
      email: string;
      carreraId: string;
      cursoId: string;
      acceptTerms: true;
    },
    meta?: RequestMeta,
  ): Promise<ChannelChallengeResponse> {
    const { data } = await this.http.serviceRequest<ChannelChallengeResponse>(
      'POST',
      '/channel-auth/register',
      { body: { channel: CHANNEL, ...input }, idempotent: true, meta },
    );
    return data;
  }

  verifyRegistrationOtp(
    tg: TelegramIdentityInput,
    challengeToken: string,
    code: string,
  ): Promise<ChannelSessionIssued> {
    return this.issueChannelSession(tg, {
      grant_type: 'registration_otp',
      challengeToken,
      code,
    });
  }

  verifyMfa(
    tg: TelegramIdentityInput,
    challengeToken: string,
    factor: { code?: string; recoveryCode?: string },
  ): Promise<ChannelSessionIssued> {
    return this.issueChannelSession(tg, {
      grant_type: 'mfa',
      challengeToken,
      ...(factor.code !== undefined ? { code: factor.code } : {}),
      ...(factor.recoveryCode !== undefined ? { recoveryCode: factor.recoveryCode } : {}),
    });
  }

  async revoke(externalUserId: string, scope: 'session' | 'identity' = 'session'): Promise<void> {
    try {
      await this.http.userRequest<void>(externalUserId, 'POST', '/channel-auth/revoke', {
        body: { scope },
      });
      await this.sessionManager.clearLocalSession(externalUserId);
    } catch (err) {
      if (err instanceof CoreApiError && (err.status === 401 || err.code === 'ACCOUNT_BLOCKED')) {
        await this.sessionManager.clearLocalSession(externalUserId);
        return;
      }
      throw err;
    }
  }

  // ── Perfil y MFA (solo lectura) ───────────────────────────────

  async getProfile(externalUserId: string): Promise<UserProfile> {
    return (await this.http.userRequest<UserProfile>(externalUserId, 'GET', '/auth/me')).data;
  }

  async getMfaStatus(externalUserId: string): Promise<MfaStatus> {
    return (await this.http.userRequest<MfaStatus>(externalUserId, 'GET', '/auth/mfa')).data;
  }

  // ── Catálogo público ──────────────────────────────────────────

  async listCareers(q?: string): Promise<Carrera[]> {
    let careers = await this.catalogCache?.getCareers();
    if (!careers) {
      const { data } = await this.http.publicRequest<Carrera[]>('GET', '/public/careers');
      careers = data.map(({ id, nombre }) => ({ id, nombre }));
      await this.catalogCache?.setCareers(careers);
    }
    const term = q?.trim().toLowerCase();
    return term ? careers.filter((c) => c.nombre.toLowerCase().includes(term)) : careers;
  }

  async listCourses(carreraId: string): Promise<Curso[]> {
    const cached = await this.catalogCache?.getCourses(carreraId);
    if (cached) return cached;

    const { data } = await this.http.publicRequest<Curso[]>(
      'GET',
      `/public/careers/${encodeURIComponent(carreraId)}/courses`,
    );
    const courses = data.map(({ id, nombre }) => ({ id, nombre }));
    await this.catalogCache?.setCourses(carreraId, courses);
    return courses;
  }

  async searchSubjects(params: {
    q: string;
    carreraId?: string;
    cursoId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AsignaturaSearchPage> {
    const { data } = await this.http.publicRequest<AsignaturaSearchPage | LegacySubjectItem[]>(
      'GET',
      '/public/subjects/search',
      { query: params },
    );
    return Array.isArray(data) ? adaptLegacySubjects(data, params) : data;
  }

  // ── Expediente ────────────────────────────────────────────────

  async getExpediente(externalUserId: string): Promise<ExpedienteItem[]> {
    return (await this.http.userRequest<ExpedienteItem[]>(externalUserId, 'GET', '/me/expediente'))
      .data;
  }

  async addToExpediente(
    externalUserId: string,
    asignaturaId: string,
    meta?: RequestMeta,
  ): Promise<{ created: boolean }> {
    const { status } = await this.http.userRequest<unknown>(
      externalUserId,
      'POST',
      '/me/expediente',
      { body: { asignaturaId }, idempotent: true, meta },
    );
    return { created: status === 201 };
  }

  async removeFromExpediente(externalUserId: string, asignaturaId: string): Promise<void> {
    await this.http.userRequest<void>(
      externalUserId,
      'DELETE',
      `/me/expediente/${encodeURIComponent(asignaturaId)}`,
    );
  }

  // ── Ofertas ───────────────────────────────────────────────────

  async listSubjectGroups(externalUserId: string, asignaturaId: string): Promise<Grupo[]> {
    await this.sessionManager.getValidAccessToken(externalUserId);
    const cached = await this.catalogCache?.getGroups(asignaturaId);
    if (cached) return cached;

    const { data } = await this.http.userRequest<Grupo[]>(
      externalUserId,
      'GET',
      `/subjects/${encodeURIComponent(asignaturaId)}/groups`,
    );
    const groups = data.map(({ id, nombre }) => ({ id, nombre }));
    await this.catalogCache?.setGroups(asignaturaId, groups);
    return groups;
  }

  async searchOffers(
    externalUserId: string,
    params: {
      asignaturaId: string;
      grupoActualId: string;
      grupoDeseadoId: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<OfferSearchPage> {
    return (
      await this.http.userRequest<OfferSearchPage>(externalUserId, 'GET', '/offers', {
        query: params,
      })
    ).data;
  }

  async listMyOffers(
    externalUserId: string,
    params?: {
      status?: OfferStatus[];
      role?: 'creator' | 'acceptor' | 'any';
      limit?: number;
      cursor?: string;
    },
  ): Promise<MyOffersPage> {
    return (
      await this.http.userRequest<MyOffersPage>(externalUserId, 'GET', '/offers/me', {
        query: {
          status: params?.status?.length ? params.status.join(',') : undefined,
          role: params?.role,
          limit: params?.limit,
          cursor: params?.cursor,
        },
      })
    ).data;
  }

  async createOffer(
    externalUserId: string,
    input: { asignaturaId: string; grupoActualId: string; grupoDeseadoId: string },
    meta?: RequestMeta,
  ): Promise<OfferActionResult> {
    return (
      await this.http.userRequest<OfferActionResult>(externalUserId, 'POST', '/offers', {
        body: input,
        idempotent: true,
        meta,
      })
    ).data;
  }

  async acceptOffer(
    externalUserId: string,
    offerId: string,
    meta?: RequestMeta,
  ): Promise<OfferActionResult> {
    return (
      await this.http.userRequest<OfferActionResult>(
        externalUserId,
        'POST',
        `/offers/${encodeURIComponent(offerId)}/accept`,
        { idempotent: true, meta },
      )
    ).data;
  }

  async closeOffer(externalUserId: string, offerId: string): Promise<OfferActionResult> {
    return (
      await this.http.userRequest<OfferActionResult>(
        externalUserId,
        'PATCH',
        `/offers/${encodeURIComponent(offerId)}/close`,
      )
    ).data;
  }

  // ── Chat de ofertas ───────────────────────────────────────────

  async getOfferMessages(
    externalUserId: string,
    offerId: string,
    params?: { limit?: number; before?: string },
  ): Promise<OfferMessagesPage> {
    return (
      await this.http.userRequest<OfferMessagesPage>(
        externalUserId,
        'GET',
        `/offers/${encodeURIComponent(offerId)}/messages`,
        { query: params },
      )
    ).data;
  }

  async sendOfferMessage(
    externalUserId: string,
    offerId: string,
    content: string,
    meta?: RequestMeta,
  ): Promise<SentMessageResult> {
    return (
      await this.http.userRequest<SentMessageResult>(
        externalUserId,
        'POST',
        `/offers/${encodeURIComponent(offerId)}/messages`,
        { body: { content }, idempotent: true, meta },
      )
    ).data;
  }

  // ── Notificaciones y preferencias ─────────────────────────────

  async getNotifications(
    externalUserId: string,
    params?: { unread?: boolean; limit?: number; cursor?: string },
  ): Promise<NotificationsPage> {
    const { data, headers } = await this.http.userRequest<NotificationItem[] | NotificationsPage>(
      externalUserId,
      'GET',
      '/notifications',
      { query: params },
    );
    return Array.isArray(data) ? { items: data, nextCursor: headers.get('x-next-cursor') } : data;
  }

  async getUnreadNotificationsCount(externalUserId: string): Promise<number> {
    const { data } = await this.http.userRequest<{ count: number }>(
      externalUserId,
      'GET',
      '/notifications/unread-count',
    );
    return data.count;
  }

  async markNotificationRead(externalUserId: string, notificationId: string): Promise<void> {
    await this.http.userRequest<unknown>(
      externalUserId,
      'PATCH',
      `/notifications/${encodeURIComponent(notificationId)}/read`,
    );
  }

  async markAllNotificationsRead(externalUserId: string): Promise<void> {
    await this.http.userRequest<unknown>(externalUserId, 'PATCH', '/notifications/read-all');
  }

  async getNotificationPreferences(externalUserId: string): Promise<NotificationPreferences> {
    return (
      await this.http.userRequest<NotificationPreferences>(
        externalUserId,
        'GET',
        '/me/notification-preferences',
      )
    ).data;
  }

  async updateNotificationPreferences(
    externalUserId: string,
    patch: { enabled?: boolean; chatMessages?: boolean },
  ): Promise<NotificationPreferences> {
    return (
      await this.http.userRequest<NotificationPreferences>(
        externalUserId,
        'PATCH',
        '/me/notification-preferences',
        { body: { telegram: patch } },
      )
    ).data;
  }
}
