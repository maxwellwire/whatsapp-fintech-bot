import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),

  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

  VTPASS_API_KEY: z.string().min(1),
  VTPASS_PUBLIC_KEY: z.string().optional(),
  VTPASS_SECRET_KEY: z.string().optional(),
  VTPASS_BASE_URL: z.string().url().default('https://vtpass.com/api'),

  APP_NAME: z.string().default('NairaBot'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  MIN_FUNDING_KOBO: z.coerce.number().int().default(10_000),
  MAX_FUNDING_KOBO: z.coerce.number().int().default(100_000_000),
  MIN_AIRTIME_KOBO: z.coerce.number().int().default(5_000),
  MAX_AIRTIME_KOBO: z.coerce.number().int().default(5_000_000),
  MIN_TRANSFER_KOBO: z.coerce.number().int().default(10_000),
  MAX_TRANSFER_KOBO: z.coerce.number().int().default(100_000_000),
  TRANSFER_FEE_FLAT_KOBO: z.coerce.number().int().default(1_000),
  TRANSFER_FEE_PERCENT: z.coerce.number().default(0),

  PIN_HASH_ROUNDS: z.coerce.number().default(12),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SKIP_WHATSAPP_SIGNATURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.SKIP_WHATSAPP_SIGNATURE) {
  console.error('SKIP_WHATSAPP_SIGNATURE is forbidden in production');
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;