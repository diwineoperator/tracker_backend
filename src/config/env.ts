import { z } from 'zod';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),

  ADMIN_USERNAME: z.string().trim().min(1).max(100),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'must be a bcrypt hash (npm run hash-password)'),

  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+[smhd]$/, 'must look like 30m, 8h or 7d')
    .default('8h'),

  /** Where attachment files are kept on disk (relative to the backend folder). */
  UPLOAD_DIR: z.string().trim().min(1).default('uploads'),

  /** Set S3_BUCKET_NAME to store attachments in S3 instead of UPLOAD_DIR. Credentials come from the instance role. */
  AWS_REGION: z.string().trim().min(1).optional(),
  S3_BUCKET_NAME: z.string().trim().min(1).optional(),
  S3_UPLOAD_PREFIX: z.string().trim().default('uploads/'),

  TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine(isValidTimezone, 'must be a valid IANA timezone, e.g. Asia/Kolkata'),
}).refine((env) => !env.S3_BUCKET_NAME || env.AWS_REGION, {
  message: 'is required when S3_BUCKET_NAME is set',
  path: ['AWS_REGION'],
});

export type Env = Omit<z.infer<typeof envSchema>, 'CORS_ORIGINS'> & {
  CORS_ORIGINS: string[];
};

/**
 * Validates configuration once at startup. Fails fast with a readable message
 * that names the offending variables but never prints their values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const { CORS_ORIGINS, ...rest } = parsed.data;
  return {
    ...rest,
    CORS_ORIGINS: CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
