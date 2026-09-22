import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { User, Wallet } from '@prisma/client';

export type UserWithWallet = User & { wallet: Wallet | null };

export function normalizePhoneNumber(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) {
    digits = '234' + digits.slice(1);
  } else if (
    digits.length === 10 &&
    (digits.startsWith('7') || digits.startsWith('8') || digits.startsWith('9'))
  ) {
    digits = '234' + digits;
  }
  return digits;
}

export class UserService {
  async findByPhone(phoneNumber: string): Promise<UserWithWallet | null> {
    return prisma.user.findUnique({
      where: { phoneNumber: normalizePhoneNumber(phoneNumber) },
      include: { wallet: true },
    });
  }

  async findOrCreate(phoneNumber: string, profileName?: string): Promise<UserWithWallet> {
    const normalized = normalizePhoneNumber(phoneNumber);
    const existing = await this.findByPhone(normalized);

    if (existing) {
      if (existing.status === 'SUSPENDED' || existing.status === 'BLOCKED') {
        throw new AppError('Account restricted. Contact support.', 403, true, 'ACCOUNT_RESTRICTED');
      }
      await prisma.user.update({
        where: { id: existing.id },
        data: { lastActiveAt: new Date() },
      });
      return existing;
    }

    const [firstName, ...rest] = (profileName ?? '').trim().split(/\s+/);
    const user = await prisma.user.create({
      data: {
        phoneNumber: normalized,
        firstName: firstName || null,
        lastName: rest.length ? rest.join(' ') : null,
        status: 'ACTIVE',
        lastActiveAt: new Date(),
        wallet: { create: { currency: 'NGN', balance: 0n, status: 'ACTIVE' } },
      },
      include: { wallet: true },
    });

    logger.info('User created', { userId: user.id, phoneNumber: normalized });
    return user;
  }
}

export const userService = new UserService();