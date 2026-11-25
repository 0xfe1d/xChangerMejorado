import 'dotenv/config';
import { z } from 'zod';

const boolFromString = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform((v) => v !== 'false' && v !== '0');

export const normalizeCoreApiUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsedUrl = new URL(trimmed);
  if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
    return `${trimmed}/api/v1`;
  }
  return trimmed;
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    USE_MOCK_CORE: boolFromString('true'),

    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
    TELEGRAM_WEBHOOK_URL: z.string().default(''),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).max(256).default('dev-webhook-secret'),

    CORE_API_URL: z
      .string()
      .url()
      .default('https://xchanger-uc.xyz/api/v1')
      .transform(normalizeCoreApiUrl),
    SERVICE_CLIENT_ID: z.string().default('telegram-bot'),
    SERVICE_CLIENT_SECRET: z.string().default(''),

    REDIS_URL: z.string().default('redis://localhost:6379/0'),
    BOT_DATABASE_URL: z.string().default(''),
    TOKEN_ENC_KEY: z.string().default(''),
  })
  .superRefine((data, ctx) => {
    if (!data.USE_MOCK_CORE) {
      if (data.SERVICE_CLIENT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SERVICE_CLIENT_SECRET'],
          message: 'SERVICE_CLIENT_SECRET es obligatorio (>= 32 chars) cuando USE_MOCK_CORE=false',
        });
      }
      if (!data.BOT_DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BOT_DATABASE_URL'],
          message: 'BOT_DATABASE_URL es obligatorio cuando USE_MOCK_CORE=false',
        });
      }
      if (!data.TOKEN_ENC_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TOKEN_ENC_KEY'],
          message: 'TOKEN_ENC_KEY es obligatorio cuando USE_MOCK_CORE=false',
        });
      }
      if (data.NODE_ENV === 'production') {
        if (!data.TELEGRAM_BOT_TOKEN.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TELEGRAM_BOT_TOKEN'],
            message: 'TELEGRAM_BOT_TOKEN es obligatorio en producción cuando USE_MOCK_CORE=false',
          });
        }
        if (
          data.TELEGRAM_WEBHOOK_SECRET === 'dev-webhook-secret' ||
          data.TELEGRAM_WEBHOOK_SECRET.length < 16
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TELEGRAM_WEBHOOK_SECRET'],
            message:
              'TELEGRAM_WEBHOOK_SECRET debe ser un secreto no por defecto de >= 16 caracteres en producción',
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Variables de entorno inválidas o faltantes en telegram-bot:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
