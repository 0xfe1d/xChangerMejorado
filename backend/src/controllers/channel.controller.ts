import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as channelAuth from '../services/channel-auth.service';
import { listIdentitiesForUser } from '../services/channel-session.service';
import * as serviceAuth from '../services/service-auth.service';
import { INSTITUTIONAL_DOMAIN } from '../services/auth.service';
import { clientIp } from './auth.controller';

// ── Validaciones comunes (§9.3) ───────────────────────────────

const channelSchema = z.literal('telegram');
const externalUserIdSchema = z.string().regex(/^\d{1,20}$/, 'externalUserId debe ser el from.id decimal de Telegram');
// Sin caracteres de control
const displayNameSchema = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u, 'Nombre visible con caracteres no válidos');
const usernameSchema = z.string().regex(/^[A-Za-z0-9_]{5,32}$/);
const otpCodeSchema = z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos');
const institutionalEmail = z
  .string()
  .email()
  .transform((e) => e.toLowerCase())
  .refine((e) => e.endsWith(INSTITUTIONAL_DOMAIN), { message: `El email debe ser una cuenta ${INSTITUTIONAL_DOMAIN}` });

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.errors[0];
    const code = issue.message.includes(INSTITUTIONAL_DOMAIN) ? 'INVALID_EMAIL_DOMAIN' : 'VALIDATION_ERROR';
    throw new AppError(400, issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message, code);
  }
  return r.data;
}

/** El canal del cuerpo debe coincidir con el scope de la credencial de servicio. */
function assertChannelMatchesService(req: Request, channel: string): void {
  if (!req.service?.scope.includes(`channel:${channel}`)) {
    throw new AppError(403, 'El canal no coincide con la credencial de servicio', 'SERVICE_FORBIDDEN');
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

// ── EP-C-01: POST /service-auth/token ─────────────────────────

const serviceTokenSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(1).max(100),
  client_secret: z.string().min(32).max(512),
  scope: z.string().max(500).optional(),
});

export const serviceToken = wrap(async (req, res) => {
  const r = serviceTokenSchema.safeParse(req.body);
  if (!r.success) throw new AppError(401, 'Credenciales de servicio incorrectas', 'SERVICE_UNAUTHORIZED');
  res.setHeader('Cache-Control', 'no-store');
  res.json(await serviceAuth.issueForClient({ clientId: r.data.client_id, clientSecret: r.data.client_secret, scope: r.data.scope }));
});

// ── EP-C-02: GET /internal/.well-known/jwks.json ──────────────

export const jwks = wrap(async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(serviceAuth.getJwks());
});

// ── EP-C-03: POST /channel-auth/link-requests ─────────────────

const linkRequestSchema = z.object({
  channel: channelSchema,
  externalUserId: externalUserIdSchema,
  displayName: displayNameSchema,
  username: usernameSchema.optional(),
});

export const createLinkRequest = wrap(async (req, res) => {
  const body = parse(linkRequestSchema, req.body);
  assertChannelMatchesService(req, body.channel);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(await channelAuth.createLinkRequest(body));
});

// ── EP-C-04 / EP-C-05 ─────────────────────────────────────────

const userCodeParam = z.string().min(8).max(12);

export const getLinkRequest = wrap(async (req, res) => {
  res.json(await channelAuth.getLinkRequest(parse(userCodeParam, req.params.userCode)));
});

export const decideLinkRequest = wrap(async (req, res) => {
  const { decision } = parse(z.object({ decision: z.enum(['approve', 'deny']) }), req.body);
  res.json(await channelAuth.decideLinkRequest(parse(userCodeParam, req.params.userCode), decision, req.user!.sub));
});

// ── EP-C-06: POST /channel-auth/token ─────────────────────────

const base = { channel: channelSchema, externalUserId: externalUserIdSchema };
const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('link_code'), ...base, deviceCode: z.string().min(20).max(100) }),
  z.object({ grant_type: z.literal('email_otp'), ...base, challengeToken: z.string().min(10).max(2000), code: otpCodeSchema }),
  z.object({ grant_type: z.literal('registration_otp'), ...base, challengeToken: z.string().min(10).max(2000), code: otpCodeSchema }),
  // La exclusividad code/recoveryCode se valida en assertOneFactor
  z.object({
    grant_type: z.literal('mfa'),
    ...base,
    challengeToken: z.string().min(10).max(2000),
    code: z.string().max(20).optional(),
    recoveryCode: z.string().max(20).optional(),
  }),
  z.object({ grant_type: z.literal('refresh_token'), ...base, refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
]);

export const token = wrap(async (req, res) => {
  const body = parse(tokenSchema, req.body);
  assertChannelMatchesService(req, body.channel);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await channelAuth.token(body as channelAuth.TokenGrantInput, { clientIp: clientIp(req) }));
});

// ── EP-C-07: POST /channel-auth/email-otp ─────────────────────

const emailOtpSchema = z.object({ ...base, email: institutionalEmail });

export const emailOtp = wrap(async (req, res) => {
  const body = parse(emailOtpSchema, req.body);
  assertChannelMatchesService(req, body.channel);
  res.status(202).json(await channelAuth.sendLoginEmailOtp(body));
});

// ── EP-C-08: POST /channel-auth/register ──────────────────────

const registerSchema = z.object({
  ...base,
  name: z.string().trim().min(2).max(100),
  email: institutionalEmail,
  carreraId: z.string().cuid(),
  cursoId: z.string().cuid(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar el aviso de no oficialidad y el tratamiento de datos' }) }),
});

export const register = wrap(async (req, res) => {
  const body = parse(registerSchema, req.body);
  assertChannelMatchesService(req, body.channel);
  res.status(202).json(await channelAuth.registerFromChannel(body));
});

// ── EP-C-09: POST /channel-auth/revoke ────────────────────────

export const revoke = wrap(async (req, res) => {
  const { scope = 'session' } = parse(z.object({ scope: z.enum(['session', 'identity']).optional() }), req.body ?? {});
  await channelAuth.revokeFromChannel(req.user!.sub, req.user!.channelSessionId!, scope);
  res.status(204).send();
});

// ── EP-C-10 / EP-C-11: /me/channels ───────────────────────────

export const listMyChannels = wrap(async (req, res) => {
  res.json(await listIdentitiesForUser(req.user!.sub));
});

export const unlinkMyChannel = wrap(async (req, res) => {
  await channelAuth.unlinkFromWeb(req.user!.sub, parse(z.string().cuid(), req.params.identityId));
  res.status(204).send();
});
