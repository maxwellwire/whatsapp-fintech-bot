import { Router, Request, Response } from 'express';
import { prisma } from '../infrastructure/database/prisma.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  let database: 'up' | 'down' = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }
  const status = database === 'up' ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.NODE_ENV,
    checks: { database },
  });
});

export default router;