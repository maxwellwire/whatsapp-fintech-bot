import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

export class WalletService {
  async creditInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      walletId: string;
      transactionId: string;
      amountKobo: bigint;
      description: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ newBalance: bigint }> {
    if (params.amountKobo <= 0n) {
      throw new AppError('Credit amount must be positive', 400, true, 'INVALID_AMOUNT');
    }

    const rows = await tx.$queryRaw<
      Array<{ id: string; balance: bigint; version: number; status: string }>
    >`SELECT id, balance, version, status FROM wallets WHERE id = ${params.walletId} FOR UPDATE`;

    const wallet = rows[0];
    if (!wallet) throw new AppError('Wallet not found', 404, true, 'WALLET_NOT_FOUND');
    if (wallet.status !== 'ACTIVE') {
      throw new AppError('Wallet is not active', 400, true, 'WALLET_INACTIVE');
    }

    const newBalance = wallet.balance + params.amountKobo;

    await tx.wallet.update({
      where: { id: params.walletId },
      data: { balance: newBalance, version: { increment: 1 } },
    });

    await tx.walletLedger.createMany({
      data: [
        {
          walletId: params.walletId,
          transactionId: params.transactionId,
          entryType: 'CREDIT',
          amount: params.amountKobo,
          balanceAfter: newBalance,
          description: params.description,
          metadata: params.metadata ?? undefined,
        },
        {
          walletId: null,
          transactionId: params.transactionId,
          entryType: 'DEBIT',
          amount: params.amountKobo,
          description: `Clearing: ${params.description}`,
          metadata: params.metadata ?? undefined,
        },
      ],
    });

    logger.info('Wallet credited', {
      walletId: params.walletId,
      amountKobo: params.amountKobo.toString(),
      newBalance: newBalance.toString(),
    });

    return { newBalance };
  }

  async debitInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      walletId: string;
      transactionId: string;
      amountKobo: bigint;
      description: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ newBalance: bigint }> {
    if (params.amountKobo <= 0n) {
      throw new AppError('Debit amount must be positive', 400, true, 'INVALID_AMOUNT');
    }

    const rows = await tx.$queryRaw<
      Array<{ id: string; balance: bigint; version: number; status: string }>
    >`SELECT id, balance, version, status FROM wallets WHERE id = ${params.walletId} FOR UPDATE`;

    const wallet = rows[0];
    if (!wallet) throw new AppError('Wallet not found', 404, true, 'WALLET_NOT_FOUND');
    if (wallet.status !== 'ACTIVE') {
      throw new AppError('Wallet is not active', 400, true, 'WALLET_INACTIVE');
    }
    if (wallet.balance < params.amountKobo) {
      throw new AppError('Insufficient balance', 400, true, 'INSUFFICIENT_BALANCE');
    }

    const newBalance = wallet.balance - params.amountKobo;

    await tx.wallet.update({
      where: { id: params.walletId },
      data: { balance: newBalance, version: { increment: 1 } },
    });

    await tx.walletLedger.createMany({
      data: [
        {
          walletId: params.walletId,
          transactionId: params.transactionId,
          entryType: 'DEBIT',
          amount: params.amountKobo,
          balanceAfter: newBalance,
          description: params.description,
          metadata: params.metadata ?? undefined,
        },
        {
          walletId: null,
          transactionId: params.transactionId,
          entryType: 'CREDIT',
          amount: params.amountKobo,
          description: `Clearing: ${params.description}`,
          metadata: params.metadata ?? undefined,
        },
      ],
    });

    return { newBalance };
  }
}

export const walletService = new WalletService();