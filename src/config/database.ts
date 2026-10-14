import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export type Database = PrismaClient;

/**
 * Every connection runs with its session timezone set to UTC.
 *
 * Why it matters: the driver hands PostgreSQL the UTC wall-clock time of each instant WITHOUT a zone
 * suffix, and PostgreSQL reads that in the SESSION timezone. On a server configured for another zone
 * (Asia/Kolkata, say) every timestamp was therefore stored hours off — invisible in the app (reads add
 * the same offset back) but wrong in raw SQL, exports and reports. Pinning the session to UTC makes
 * what is stored the true instant, whatever the server, the host or the Node process is set to.
 */
export const DB_SESSION_OPTIONS = '-c TimeZone=UTC';

export function createDatabase(databaseUrl: string): Database {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, options: DB_SESSION_OPTIONS }) });
}

/** Cheap connectivity probe used at startup and by GET /api/health. */
export async function checkDatabase(db: Database): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}
