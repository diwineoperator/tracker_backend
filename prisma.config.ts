import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 keeps the connection URL out of schema.prisma. The CLI (migrate,
// studio) reads it here; the running app builds its own client from validated
// config (see src/config/database.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
