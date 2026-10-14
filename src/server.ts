import 'dotenv/config';
import { createApp } from './app';
import { checkDatabase, createDatabase } from './config/database';
import { loadEnv } from './config/env';
import path from 'node:path';
import { PrismaAttachmentRepository } from './modules/attachment/attachment.repository';
import { LocalFileStorage } from './modules/attachment/file-storage';
import { PrismaDepartmentRepository } from './modules/department/department.repository';
import { PrismaMemberRepository } from './modules/member/member.repository';
import { PrismaRequestRepository } from './modules/request/request.repository';
import { PrismaTaskRepository } from './modules/task/task.repository';
import { PrismaTimeTrackerRepository } from './modules/time-tracker/time-tracker.repository';
import { systemClock } from './utils/clock';
import { logger } from './utils/logger';

async function main() {
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);

  // Fail fast if PostgreSQL is unreachable, with a message that hides the URL.
  try {
    await checkDatabase(db);
  } catch (err) {
    logger.error(
      'Cannot connect to PostgreSQL. Is it running, and does DATABASE_URL match your local database? (see README → Local PostgreSQL setup)',
      err,
    );
    process.exit(1);
  }

  const app = createApp({
    env,
    memberRepository: new PrismaMemberRepository(db),
    departmentRepository: new PrismaDepartmentRepository(db),
    taskRepository: new PrismaTaskRepository(db),
    requestRepository: new PrismaRequestRepository(db),
    attachmentRepository: new PrismaAttachmentRepository(db),
    fileStorage: new LocalFileStorage(path.resolve(env.UPLOAD_DIR)),
    timeTrackerRepository: new PrismaTimeTrackerRepository(db),
    clock: systemClock,
    checkDatabase: () => checkDatabase(db),
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`, {
      env: env.NODE_ENV,
      timezone: env.TIMEZONE,
    });
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await db.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
