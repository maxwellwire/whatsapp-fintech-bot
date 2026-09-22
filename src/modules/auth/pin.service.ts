import bcrypt from 'bcrypt';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

export class PinService {
  async setPin(userId: string, pin: string): Promise<void> {
    if (!/^\d{4,6}$/.test(pin)) {
      throw new AppError('PIN must be 4–6 digits', 400, true, 'INVALID_PIN');
    }
    const pinHash = await bcrypt.hash(pin, env.PIN_HASH_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash, pinAttempts: 0, pinLockedUntil: null },
    });
  }

  async verifyPin(userId: string, pin: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404, true, 'USER_NOT_FOUND');

    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
      throw new AppError('PIN locked. Try again later.', 429, true, 'PIN_LOCKED');
    }

    if (!user.pinHash) {
      throw new AppError('PIN not set. Reply with a 4–6 digit PIN to set one.', 400, true, 'PIN_NOT_SET');
    }

    const ok = await bcrypt.compare(pin, user.pinHash);
    if (!ok) {
      const attempts = user.pinAttempts + 1;
      const data: { pinAttempts: number; pinLockedUntil?: Date } = { pinAttempts: attempts };
      if (attempts >= MAX_ATTEMPTS) {
        data.pinLockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        data.pinAttempts = 0;
      }
      await prisma.user.update({ where: { id: userId }, data });
      throw new AppError('Incorrect PIN', 401, true, 'INVALID_PIN');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { pinAttempts: 0, pinLockedUntil: null },
    });
    return true;
  }

  hasPin(user: { pinHash: string | null }): boolean {
    return Boolean(user.pinHash);
  }
}

export const pinService = new PinService();