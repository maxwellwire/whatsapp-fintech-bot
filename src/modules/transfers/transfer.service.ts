import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { walletService } from '../wallets/wallet.service.js';
import { whatsappClient } from '../whatsapp/client.js';
import { formatKobo } from '../../utils/money.js';
import { writeAudit } from '../shared/audit.js';
import { paystackTransferProvider } from './providers/paystack.provider.js';
import type { TransferProvider } from './providers/types.js';
import type { UserWithWallet } from '../users/user.service.js';

export function calculateTransferFeeKobo(amountKobo: bigint): bigint {
  const flat = BigInt(env.TRANSFER_FEE_FLAT_KOBO);
  const percentPart = BigInt(Math.ceil((Number(amountKobo) * env.TRANSFER_FEE_PERCENT) / 100));
  return flat + percentPart;
}

export class TransferService {
  constructor(private readonly provider: TransferProvider = paystackTransferProvider) {}

  listBanks() {
    return this.provider.listBanks();
  }

  async resolveAccount(accountNumber: string, bankCode: string) {
    const digits = accountNumber.replace(/\D/g, '');
    if (digits.length !== 10) {
      throw new AppError('Account number must be 10 digits', 400, true, 'INVALID_ACCOUNT');
    }
    return this.provider.resolveAccount(digits, bankCode);
  }

  async transfer(input: {
    user: UserWithWallet;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    bankName: string;
    amountKobo: bigint;
    narration?: string;
  }): Promise<void> {
    const { user, amountKobo } = input;
    if (!user.wallet) throw new AppError('No wallet', 400, true, 'NO_WALLET');

    if (amountKobo < BigInt(env.MIN_TRANSFER_KOBO) || amountKobo > BigInt(env.MAX_TRANSFER_KOBO)) {
      throw new AppError('Amount out of range', 400, true, 'INVALID_AMOUNT');
    }

    const fee = calculateTransferFeeKobo(amountKobo);
    const total = amountKobo + fee;

    if (user.wallet.balance < total) {
      throw new AppError(
        `Insufficient balance. Required ${formatKobo(total)} (incl. fee)`,
        400,
        true,
        'INSUFFICIENT_BALANCE'
      );
    }

    const externalReference = `NBX${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const idempotencyKey = `xfer_${user.id}_${randomUUID()}`;

    const { transactionId, bankTransferId } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

        const transaction = await tx.transaction.create({
          data: {
            userId: user.id,
            type: 'BANK_TRANSFER',
            status: 'PENDING',
            amount: amountKobo,
            fee,
            description: `Transfer to ${input.accountName}`,
            idempotencyKey,
            externalReference,
            provider: this.provider.name,
          },
        });

        const bankTransfer = await tx.bankTransfer.create({
          data: {
            transactionId: transaction.id,
            accountNumber: input.accountNumber,
            accountName: input.accountName,
            bankCode: input.bankCode,
            bankName: input.bankName,
            amount: amountKobo,
            narration: input.narration || 'Transfer',
            provider: this.provider.name,
            status: 'PENDING',
          },
        });

        await walletService.debitInTransaction(tx, {
          walletId: user.wallet!.id,
          transactionId: transaction.id,
          amountKobo: total,
          description: `Bank transfer + fee`,
          metadata: { transferAmount: amountKobo.toString(), fee: fee.toString() },
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'PROCESSING' },
        });

        return { transactionId: transaction.id, bankTransferId: bankTransfer.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }
    );

    const initiated = await this.provider.initiateTransfer({
      amountKobo,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      accountName: input.accountName,
      narration: input.narration || 'Transfer',
      reference: externalReference,
    });

    // Never trust initiate alone
    if (initiated.status === 'success' || initiated.status === 'pending') {
      const ref = initiated.providerReference || externalReference;
      const verified = await this.provider.verifyTransfer(ref);

      if (verified.status === 'success') {
        await prisma.$transaction([
          prisma.transaction.update({
            where: { id: transactionId },
            data: {
              status: 'SUCCESS',
              providerReference: verified.providerReference || ref,
              completedAt: new Date(),
            },
          }),
          prisma.bankTransfer.update({
            where: { id: bankTransferId },
            data: {
              status: 'SUCCESS',
              providerReference: verified.providerReference || ref,
              sessionId: verified.sessionId ?? null,
            },
          }),
        ]);

        const wallet = await prisma.wallet.findFirst({
          where: { userId: user.id },
        });

        await whatsappClient.sendText(
          user.phoneNumber,
          `✅ *Transfer Successful*\n\nTo: *${input.accountName}*\nBank: *${input.bankName}*\nAccount: *${input.accountNumber}*\nAmount: *${formatKobo(amountKobo)}*\nFee: *${formatKobo(fee)}*\n${wallet ? `Balance: *${formatKobo(wallet.balance)}*\n` : ''}\nRef: \`${ref}\`\n\nType *menu*.`
        );
        await writeAudit({
          userId: user.id,
          action: 'TRANSFER_SUCCESS',
          resource: 'transaction',
          resourceId: transactionId,
        });
        return;
      }

      if (verified.status === 'pending') {
        await prisma.transaction.update({
          where: { id: transactionId },
          data: { providerReference: ref, status: 'PROCESSING' },
        });
        await whatsappClient.sendText(
          user.phoneNumber,
          `⏳ Transfer processing to ${input.accountName}. Ref: \`${externalReference}\``
        );
        return;
      }
    }

    // Failed / unknown → refund total
    await prisma.$transaction(async (tx) => {
      const cas = await tx.transaction.updateMany({
        where: { id: transactionId, status: { in: ['PENDING', 'PROCESSING'] } },
        data: {
          status: 'FAILED',
          failureReason: initiated.message || 'Transfer failed',
        },
      });
      if (cas.count === 0) return;

      const reversal = await tx.transaction.create({
        data: {
          userId: user.id,
          type: 'REVERSAL',
          status: 'SUCCESS',
          amount: total,
          description: 'Refund failed transfer',
          idempotencyKey: `rev_xfer_${transactionId}_${randomUUID()}`,
          provider: this.provider.name,
          completedAt: new Date(),
        },
      });

      await walletService.creditInTransaction(tx, {
        walletId: user.wallet!.id,
        transactionId: reversal.id,
        amountKobo: total,
        description: 'Refund failed transfer',
      });

      await tx.bankTransfer.update({
        where: { id: bankTransferId },
        data: { status: 'FAILED' },
      });
    });

    await whatsappClient.sendText(
      user.phoneNumber,
      `❌ *Transfer Failed*\n\n${initiated.message || 'Failed'}\nWallet refunded.\n\nType *menu*.`
    );
    logger.info('Transfer failed and refunded', { transactionId });
  }
}

export const transferService = new TransferService();