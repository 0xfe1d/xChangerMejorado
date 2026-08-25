import { z } from 'zod';

// Valida y tipifica todas las variables de entorno al arranque.
// Si falta alguna variable crítica, el proceso termina con un error claro.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // ── Base de datos ─────────────────────────────────────────────
  // DATABASE_URL → PgBouncer (runtime). Debe incluir ?pgbouncer=true
  DATABASE_URL: z.string().url(),
  // DIRECT_URL → PostgreSQL directo (migraciones/seeds)
  DIRECT_URL: z.string().url(),

  // ── JWT ───────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // Vida útil del Access Token (ej: "15m")
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  // Vida útil del Refresh Token (ej: "7d")
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Vida útil del token OTP de registro (ej: "30m")
  JWT_OTP_EXPIRES_IN: z.string().default('30m'),

  // ── CORS ──────────────────────────────────────────────────────
  FRONTEND_URL: z.string().url(),

  // ── Email (Nodemailer) ────────────────────────────────────────
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().email(),
  SMTP_PASS: z.string(),
  SMTP_FROM: z.string().email(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Variables de entorno inválidas o faltantes:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
