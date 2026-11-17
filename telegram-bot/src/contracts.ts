/**
 * ─────────────────────────────────────────────────────────────
 * CONTRATO COMPARTIDO DEL BOT (Back <-> Front de Telegram)
 * ─────────────────────────────────────────────────────────────
 * Este archivo define las "firmas" exactas entre:
 *   1. El BACK del bot (CoreClient, StateStore, CallbackStore)
 *   2. El FRONT del bot (handlers, menús, botones, vistas de eventos)
 *
 * Basado en xchanger_escalado.pdf (§6, §9 y §11).
 */

// ── Errores del Core (§5.10) ──────────────────────────────────

export class CoreApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CoreApiError';
  }
}

// ── Tipos de datos (DTOs que devuelve el Core) ────────────────

export type Role = 'ESTUDIANTE' | 'EMBAJADOR' | 'PROPIETARIO' | 'BLOQUEADO';
export type OfferStatus = 'OPEN' | 'ACCEPTED' | 'CLOSED' | 'INACTIVE';

export interface TelegramIdentityInput {
  /** ID numérico de Telegram como cadena (from.id) */
  externalUserId: string;
  /** ID del chat privado de Telegram */
  chatId: string;
  /** Nombre visible en Telegram (first_name + last_name) */
  displayName: string;
  /** @username sin arroba, opcional */
  username?: string;
}

export interface RequestMeta {
  /** update_id de Telegram para construir Idempotency-Key = tg:<updateId> */
  updateId?: number;
}

// ── Cuenta, vinculación y MFA ─────────────────────────────────

export interface LinkRequestCreated {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface ChannelChallengeResponse {
  challengeToken: string;
  expiresIn: number;
  codeLength: number;
}

export interface ChannelSessionUser {
  id: string;
  name: string;
  role: Role;
  mfaEnabled: boolean;
  hasExpediente: boolean;
}

export interface ChannelSessionIssued {
  kind: 'session';
  user: ChannelSessionUser;
  sessionId: string;
  absoluteExpiresAt: string;
}

export interface ChannelMfaRequired {
  kind: 'mfa_required';
  challengeToken: string;
  expiresIn: number;
  methods: Array<'xotp' | 'recovery_code'>;
}

export type ChannelAuthResult = ChannelSessionIssued | ChannelMfaRequired;

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
  carreraId: string | null;
  cursoId: string | null;
  mfaEnabled: boolean;
}

export interface MfaStatus {
  enabled: boolean;
  method: 'xotp' | null;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  pendingEnrollment: { enrollmentId: string; expiresAt: string } | null;
}

// ── Catálogo y expediente ─────────────────────────────────────

export interface Carrera {
  id: string;
  nombre: string;
}

export interface Curso {
  id: string;
  nombre: string;
}

export interface Grupo {
  id: string;
  nombre: string;
}

export interface AsignaturaSearchItem {
  id: string;
  codigo: string;
  nombre: string;
  cursoId: string;
}

export interface AsignaturaSearchPage {
  items: AsignaturaSearchItem[];
  total: number;
}

export interface ExpedienteItem {
  id: string;
  codigo: string;
  nombre: string;
  cursoId: string;
  grupos: Grupo[];
  curso: {
    id: string;
    nombre: string;
    carreraId: string;
    carrera: { nombre: string };
  };
}

// ── Ofertas y mensajería ──────────────────────────────────────

export interface OfferSearchItem {
  id: string;
  createdAt: string;
  asignatura: { id: string; codigo: string; nombre: string };
  grupoActual: Grupo;
  grupoDeseado: Grupo;
  creator: { name: string };
}

export interface OfferSearchPage {
  items: OfferSearchItem[];
  nextCursor: string | null;
}

export interface MyOfferItem {
  id: string;
  createdAt: string;
  status: OfferStatus;
  asignatura: { id: string; codigo: string; nombre: string };
  grupoActual: Grupo;
  grupoDeseado: Grupo;
  isCreator: boolean;
  counterpart: { name: string } | null;
}

export interface MyOffersPage {
  items: MyOfferItem[];
  nextCursor: string | null;
}

export interface OfferActionResult {
  id: string;
  status: OfferStatus;
  asignatura: { id: string; codigo: string; nombre: string };
  grupoActual: Grupo;
  grupoDeseado: Grupo;
  user?: { id: string; name: string; email?: string };
  acceptedBy?: { id: string; name: string; email?: string } | null;
}

export interface OfferMessageItem {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  isMine: boolean;
}

export interface OfferMessagesPage {
  items: OfferMessageItem[];
  hasMore: boolean;
  chatOpen: boolean;
}

export interface SentMessageResult {
  id: string;
  content: string;
  timestamp: string;
  authorId: string;
}

// ── Notificaciones y preferencias ─────────────────────────────

export interface NotificationItem {
  id: string;
  asunto: string;
  contenido: string;
  isRead: boolean;
  timestamp: string;
}

export interface NotificationsPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

export interface NotificationPreferences {
  email: { enabled: boolean; editable: boolean };
  telegram: { enabled: boolean; linked: boolean; chatMessages: boolean };
  web: { enabled: boolean };
}

// ─────────────────────────────────────────────────────────────
// 1. CORE CLIENT (Lo implementa el Back, lo llama el Front)
// ─────────────────────────────────────────────────────────────

export interface CoreClient {
  // ── Sesión y vinculación ──────────────────────────────────
  /** Devuelve true si este usuario de Telegram tiene sesión vinculada localmente */
  isLinked(externalUserId: string): Promise<boolean>;

  /** EP-C-03: inicia vinculación por dispositivo */
  createLinkRequest(tg: TelegramIdentityInput): Promise<LinkRequestCreated>;

  /** EP-C-06 (link_code): verifica si el usuario ya aprobó en la web y guarda la sesión */
  exchangeLinkCode(tg: TelegramIdentityInput, deviceCode: string): Promise<ChannelSessionIssued>;

  /** EP-C-07: envía OTP de login al correo institucional */
  sendEmailOtp(externalUserId: string, email: string): Promise<ChannelChallengeResponse>;

  /** EP-C-06 (email_otp): valida el OTP; puede emitir sesión o pedir MFA */
  verifyEmailOtp(tg: TelegramIdentityInput, challengeToken: string, code: string): Promise<ChannelAuthResult>;

  /** EP-C-08: crea cuenta pendiente sin contraseña desde Telegram */
  registerFromTelegram(
    input: {
      externalUserId: string;
      name: string;
      email: string;
      carreraId: string;
      cursoId: string;
      acceptTerms: true;
    },
    meta?: RequestMeta,
  ): Promise<ChannelChallengeResponse>;

  /** EP-C-06 (registration_otp): confirma el OTP del alta y crea la sesión */
  verifyRegistrationOtp(tg: TelegramIdentityInput, challengeToken: string, code: string): Promise<ChannelSessionIssued>;

  /** EP-C-06 (mfa): completa segundo factor con XOTP o código de recuperación */
  verifyMfa(
    tg: TelegramIdentityInput,
    challengeToken: string,
    factor: { code?: string; recoveryCode?: string },
  ): Promise<ChannelSessionIssued>;

  /** EP-C-09: revoca sesión o desvincula identidad y borra datos locales */
  revoke(externalUserId: string, scope?: 'session' | 'identity'): Promise<void>;

  // ── Perfil y MFA (solo lectura) ───────────────────────────
  /** EP-R-04 */
  getProfile(externalUserId: string): Promise<UserProfile>;
  /** EP-C-20 */
  getMfaStatus(externalUserId: string): Promise<MfaStatus>;

  // ── Catálogo público (para registro y búsqueda) ───────────
  /** EP-R-01 */
  listCareers(q?: string): Promise<Carrera[]>;
  /** EP-R-02 */
  listCourses(carreraId: string): Promise<Curso[]>;
  /** EP-R-03 / EP-C-16 */
  searchSubjects(params: {
    q: string;
    carreraId?: string;
    cursoId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AsignaturaSearchPage>;

  // ── Expediente ────────────────────────────────────────────
  /** EP-R-05 */
  getExpediente(externalUserId: string): Promise<ExpedienteItem[]>;
  /** EP-R-06 */
  addToExpediente(externalUserId: string, asignaturaId: string, meta?: RequestMeta): Promise<{ created: boolean }>;
  /** EP-R-07 */
  removeFromExpediente(externalUserId: string, asignaturaId: string): Promise<void>;

  // ── Ofertas ───────────────────────────────────────────────
  /** EP-C-14 */
  listSubjectGroups(externalUserId: string, asignaturaId: string): Promise<Grupo[]>;
  /** EP-C-12 */
  searchOffers(
    externalUserId: string,
    params: {
      asignaturaId: string;
      grupoActualId: string;
      grupoDeseadoId: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<OfferSearchPage>;
  /** EP-C-13 */
  listMyOffers(
    externalUserId: string,
    params?: {
      status?: OfferStatus[];
      role?: 'creator' | 'acceptor' | 'any';
      limit?: number;
      cursor?: string;
    },
  ): Promise<MyOffersPage>;
  /** EP-R-10 */
  createOffer(
    externalUserId: string,
    input: { asignaturaId: string; grupoActualId: string; grupoDeseadoId: string },
    meta?: RequestMeta,
  ): Promise<OfferActionResult>;
  /** EP-R-11 */
  acceptOffer(externalUserId: string, offerId: string, meta?: RequestMeta): Promise<OfferActionResult>;
  /** EP-R-12 */
  closeOffer(externalUserId: string, offerId: string): Promise<OfferActionResult>;

  // ── Chat de ofertas ───────────────────────────────────────
  /** EP-C-15 */
  getOfferMessages(
    externalUserId: string,
    offerId: string,
    params?: { limit?: number; before?: string },
  ): Promise<OfferMessagesPage>;
  /** EP-R-13 */
  sendOfferMessage(
    externalUserId: string,
    offerId: string,
    content: string,
    meta?: RequestMeta,
  ): Promise<SentMessageResult>;

  // ── Notificaciones y preferencias ─────────────────────────
  /** EP-R-14 */
  getNotifications(
    externalUserId: string,
    params?: { unread?: boolean; limit?: number; cursor?: string },
  ): Promise<NotificationsPage>;
  /** EP-R-15 */
  getUnreadNotificationsCount(externalUserId: string): Promise<number>;
  /** EP-R-16 */
  markNotificationRead(externalUserId: string, notificationId: string): Promise<void>;
  /** PATCH /notifications/read-all */
  markAllNotificationsRead(externalUserId: string): Promise<void>;
  /** EP-C-17 */
  getNotificationPreferences(externalUserId: string): Promise<NotificationPreferences>;
  /** EP-C-18 */
  updateNotificationPreferences(
    externalUserId: string,
    patch: { enabled?: boolean; chatMessages?: boolean },
  ): Promise<NotificationPreferences>;
}

// ─────────────────────────────────────────────────────────────
// 2. ESTADO CONVERSACIONAL Y BOTONES (Back -> Front)
// ─────────────────────────────────────────────────────────────

export interface ConversationState {
  /** Nombre del paso actual, ej: "BUSCAR:ELEGIR_ASIGNATURA", "CHAT:ACTIVO" */
  step: string;
  /** Datos temporales del flujo en curso */
  data: Record<string, unknown>;
}

export interface StateStore {
  get(chatId: string): Promise<ConversationState | null>;
  set(chatId: string, state: ConversationState, ttlSec?: number): Promise<void>;
  clear(chatId: string): Promise<void>;
}

export interface CallbackPayload {
  /** Acción del botón, ej: "offer:accept", "exp:add", "chat:open" */
  action: string;
  /** Datos del botón (puede incluir CUIDs largos; CallbackStore los acorta a < 64 bytes) */
  data: Record<string, unknown>;
}

export interface CallbackStore {
  /** Guarda el payload y devuelve una clave corta (< 64 bytes) para callback_data */
  encode(payload: CallbackPayload, ttlSec?: number): Promise<string>;
  /** Recupera el payload original a partir de la clave del botón */
  decode(key: string): Promise<CallbackPayload | null>;
}

// ─────────────────────────────────────────────────────────────
// 3. EVENTOS ASÍNCRONOS DEL CORE (Back escucha -> Front renderiza)
// ─────────────────────────────────────────────────────────────

export type NotificationKind =
  | 'OFFER_CREATED'
  | 'OFFER_ACCEPTED'
  | 'CHAT_MESSAGE'
  | 'ENTITY_DELETED'
  | 'TICKET_MESSAGE'
  | 'SECURITY'
  | 'GENERAL';

export interface NotificationCreatedEvent {
  notificationId: string;
  userId: string;
  asunto: string;
  contenido: string;
  kind: NotificationKind;
  refs: { offerId?: string; ticketId?: string };
  delivery?: { telegram: boolean; telegramChatMessages: boolean };
}

export interface OfferMessageCreatedEvent {
  offerId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface OfferStatusChangedEvent {
  offerId: string;
  from: OfferStatus;
  to: OfferStatus;
  actorId: string | null;
  asignatura: { codigo: string; nombre: string };
}

export interface ChannelLinkApprovedEvent {
  channel: 'telegram';
  externalUserId: string;
  linkRequestId: string;
}

export interface ChannelLinkDeniedEvent {
  channel: 'telegram';
  externalUserId: string;
  linkRequestId: string;
}

export interface ChannelSessionRevokedEvent {
  channel: 'telegram';
  externalUserId: string;
  sessionId: string;
  reason: 'USER' | 'ADMIN' | 'BLOCKED' | 'REUSE_DETECTED' | 'MFA_RESET';
}

export interface AccountBlockedEvent {
  userId: string;
  permanent: boolean;
  until: string | null;
  reason: string;
}

export interface AccountUnblockedEvent {
  userId: string;
}

/**
 * Handlers que implementa el Front del bot para mostrar en Telegram
 * los eventos que el Back recibe desde Redis Streams (xchanger:events).
 */
export interface BotEventHandlers {
  onNotificationCreated(chatId: string, event: NotificationCreatedEvent): Promise<void>;
  onOfferMessageCreated(chatId: string, recipientCoreUserId: string, event: OfferMessageCreatedEvent): Promise<void>;
  onOfferStatusChanged(chatId: string, event: OfferStatusChangedEvent): Promise<void>;
  onChannelLinkApproved(chatId: string, event: ChannelLinkApprovedEvent): Promise<void>;
  onChannelLinkDenied(chatId: string, event: ChannelLinkDeniedEvent): Promise<void>;
  onChannelSessionRevoked(chatId: string, event: ChannelSessionRevokedEvent): Promise<void>;
  onAccountBlocked(chatId: string, event: AccountBlockedEvent): Promise<void>;
  onAccountUnblocked(chatId: string, event: AccountUnblockedEvent): Promise<void>;
}

