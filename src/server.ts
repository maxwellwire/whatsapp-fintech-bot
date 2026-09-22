import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { disconnectPrisma } from './infrastructure/database/prisma.js';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(`Server on http://${env.HOST}:${env.PORT}`);
  logger.info(`Health: /health`);
  logger.info(`WhatsApp webhook: /webhooks/whatsapp`);
  logger.info(`Paystack webhook: /webhooks/payments/paystack`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} — shutting down`);
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('unhandledRejection', r));
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', e);
  process.exit(1);
});