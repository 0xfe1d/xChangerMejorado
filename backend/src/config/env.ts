import { z } from 'zod';
import { durationToMs } from '../utils/duration';

// Valida y tipifica todas las variables de entorno al arranque (ADR-13, RCF-02).
// Si falta alguna variable crítica, el proceso termina con un error claro.

/** Convierte "true"/"false"/"1"/"0" en boolean (z.coerce.boolean() trata "false" como true). */
const boolFromString = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform((v) => v !== 'false' && v !== '0');

/** Cliente de servicio autorizado a pedir JWT de servicio (EP-C-01). */
const serviceClientSchema = z.object({
  clientId: z.string().min(1),
  // SHA-256 (hex) del client_secret: el secreto en claro nunca se guarda en el core
  secretSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.string().min(1)).min(1),
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // ── Base de datos ─────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  // ── Redis (bus de eventos, límites, idempotencia, adaptador de sockets) ──
  REDIS_URL: z.string().url().default('redis://localhost:6379/0'),

  // ── JWT de sesión web ─────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Sesión con "Recordar inicio de sesión": refresh token y su cookie duran esto
  JWT_REFRESH_REMEMBER_EXPIRES_IN: z.string().default('30d'),
  JWT_OTP_EXPIRES_IN: z.string().default('30m'),

  // ── Sesiones de canal (ADR-18) ────────────────────────────────
  JWT_CHANNEL_SECRET: z.string().min(32),
  CHANNEL_REFRESH_IDLE_DAYS: z.coerce.number().int().positive().default(30),
  CHANNEL_REFRESH_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(180),
  CHANNEL_LINK_BASE_URL: z.string().url().default('http://localhost:4321/vincular'),

  // ── Autenticación de servicios (ADR-20) ───────────────────────
  // Clave privada ES256 (PEM PKCS#8). Si falta fuera de producción se genera
  // una efímera al arrancar (ver services/service-auth.service.ts).
  SERVICE_JWT_PRIVATE_KEY: z.string().optional(),
  SERVICE_JWT_KID: z.string().default('core-dev'),
  SERVICE_CLIENTS: z
    .string()
    .default('[]')
    .transform((raw, ctx) => {
      try {
        return z.array(serviceClientSchema).parse(JSON.parse(raw));
      } catch (e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `SERVICE_CLIENTS inválido: ${(e as Error).message}` });
        return z.NEVER;
      }
    }),

  // ── Cliente del mfa-service (ADR-23) ──────────────────────────
  MFA_SERVICE_URL: z.string().url().default('http://mfa:8081'),
  MFA_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  // AR-01: en producción el alta de MFA (QR con el secreto) exige HTTPS.
  // Solo se desactiva para pruebas locales en http://localhost.
  MFA_REQUIRE_HTTPS: boolFromString('true'),

  // ── Proxy y cookies ───────────────────────────────────────────
  // Número de saltos de proxy de confianza (Nginx = 1). Resuelve AR-02 con req.ip.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  COOKIE_SECURE: boolFromString('true'),

  // ── Outbox ────────────────────────────────────────────────────
  // Intervalo del publicador del outbox en ms; 0 = no arrancar el bucle (tests)
  OUTBOX_POLL_MS: z.coerce.number().int().min(0).default(250),

  // ── CORS ──────────────────────────────────────────────────────
  FRONTEND_URL: z.string().url(),

  // ── Email (Nodemailer) ────────────────────────────────────────
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: boolFromString('false'),
  SMTP_USER: z.string().email(),
  SMTP_PASS: z.string(),
  SMTP_FROM: z.string().email(),
});

const parsed = envSchema
  .superRefine((e, ctx) => {
    for (const k of ['JWT_ACCESS_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN', 'JWT_REFRESH_REMEMBER_EXPIRES_IN'] as const) {
      if (durationToMs(e[k]) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'Duración inválida (usa p. ej. 15m, 7d, 30d)' });
      }
    }
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Variables de entorno inválidas o faltantes:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && !parsed.data.SERVICE_JWT_PRIVATE_KEY) {
  console.error('❌  SERVICE_JWT_PRIVATE_KEY es obligatoria en producción.');
  process.exit(1);
}

export const env = parsed.data;
export type ServiceClient = z.infer<typeof serviceClientSchema>;
