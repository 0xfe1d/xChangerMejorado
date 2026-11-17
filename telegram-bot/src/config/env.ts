import 'dotenv/config';
import { z } from 'zod';

const boolFromString = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform((v) => v !== 'false' && v !== '0');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    USE_MOCK_CORE: boolFromString('true'),

    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).max(256).default('dev-webhook-secret'),

    CORE_API_URL: z.string().url().default('http://localhost:4000/api/v1'),
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
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Variables de entorno inválidas o faltantes en telegram-bot:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
