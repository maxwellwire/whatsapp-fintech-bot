import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from './errorHandler.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function validateWhatsAppSignature(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (env.NODE_ENV === 'development' && env.SKIP_WHATSAPP_SIGNATURE) {
    logger.warn('Skipping WhatsApp signature validation (development only)');
    next();
    return;
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature) {
    next(new AppError('Missing signature', 401, true, 'MISSING_SIGNATURE'));
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    next(new AppError('Unable to validate signature', 500, true, 'RAW_BODY_MISSING'));
    return;
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');

  if (!safeEqual(signature, expected)) {
    logger.warn('Invalid WhatsApp webhook signature');
    next(new AppError('Invalid signature', 401, true, 'INVALID_SIGNATURE'));
    return;
  }

  next();
}