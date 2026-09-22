import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { paystackPaymentProvider } from './providers/paystack.provider.js';
import { walletService } from '../wallets/wallet.service.js';
import { whatsappClient } from '../whatsapp/client.js';
import { formatKobo } from '../../utils/money.js';
import { writeAudit } from '../shared/audit.js';
import type { UserWithWallet } from '../users/user.service.js';
import type { VerifyPaymentResult } from './providers/types.js';
import type { PaymentProvider } from './providers/types.js';

export class FundingService {
  constructor(private readonly provider: PaymentProvider = paystackPaymentProvider) {}

  async initiateFunding(
    user: UserWithWallet,
    amountKobo: bigint
  ): Promise<{ paymentLink: string; reference: string }> {
    if (!user.wallet) throw new AppError('No wallet', 400, true, 'NO_WALLET');

    if (amountKobo < BigInt(env.MIN_FUNDING_KOBO)) {
      throw new AppError(`Minimum funding is ${formatKobo(env.MIN_FUNDING_KOBO)}`, 400, true, 'AMOUNT_TOO_LOW');
    }
    if (amountKobo > BigInt(env.MAX_FUNDING_KOBO)) {
      throw new AppError(`Maximum funding is ${formatKobo(env.MAX_FUNDING_KOBO)}`, 400, true, 'AMOUNT_TOO_HIGH');
    }

    const idempotencyKey = `fund_${user.id}_${randomUUID()}`;
    const externalReference = `NB-FUND-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;

    const { transaction, payment } = await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          userId: user.id,
          type: 'WALLET_FUNDING',
          status: 'PENDING',
          amount: amountKobo,
          fee: 0n,
          currency: 'NGN',
          description: `Wallet funding ${formatKobo(amountKobo)}`,
          idempotencyKey,
          externalReference,
          provider: this.provider.name,
        },
      });

      const payment = await tx.payment.create({
        data: {
          userId: user.id,
          transactionId: transaction.id,
          amount: amountKobo,
          currency: 'NGN',
          status: 'PENDING',
          provider: 'PAYSTACK',
          metadata: { phoneNumber: user.phoneNumber },
        },
      });

      return { transaction, payment };
    });

    const email = user.email || `${user.phoneNumber}@nairabot.local`;
    const init = await this.provider.initializePayment({
      amountKobo,
      email,
      reference: externalReference,
      metadata: {
        userId: user.id,
        paymentId: payment.id,
        transactionId: transaction.id,
      },
      callbackUrl: `${env.APP_BASE_URL}/payments/callback`,
    });

    if (!init.success || !init.authorizationUrl) {
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: 'FAILED', failureReason: init.message },
        }),
        prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: init.message },
        }),
      ]);
      throw new AppError(init.message || 'Unable to start payment', 502, true, 'PROVIDER_INIT_FAILED');
    }

    const pref = init.providerReference || externalReference;
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerReference: pref, authorizationUrl: init.authorizationUrl },
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { providerReference: pref, status: 'PROCESSING' },
    });

    await writeAudit({
      userId: user.id,
      action: 'FUNDING_INITIATED',
      resource: 'payment',
      resourceId: payment.id,
      metadata: { amountKobo: amountKobo.toString(), reference: externalReference },
    });

    return { paymentLink: init.authorizationUrl, reference: externalReference };
  }

  async processSuccessfulPayment(
    providerReference: string,
    verified: VerifyPaymentResult
  ): Promise<{ alreadyProcessed: boolean }> {
    const payment =
      (await prisma.payment.findFirst({
        where: { provider: 'PAYSTACK', providerReference },
        include: { user: { include: { wallet: true } }, transaction: true },
      })) ||
      (
        await prisma.transaction.findFirst({
          where: {
            provider: this.provider.name,
            OR: [{ providerReference }, { externalReference: providerReference }],
          },
          include: { payment: true, user: { include: { wallet: true } } },
        })
      )?.payment;

    if (!payment) {
      throw new AppError('Payment not found', 404, true, 'PAYMENT_NOT_FOUND');
    }

    if (payment.status === 'SUCCESS') {
      return { alreadyProcessed: true };
    }

    return this.completePayment(payment.id, verified);
  }

  private async completePayment(
    paymentId: string,
    verified: VerifyPaymentResult
  ): Promise<{ alreadyProcessed: boolean }> {
    const result = await prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
          include: { user: { include: { wallet: true } }, transaction: true },
        });

        if (!payment) throw new AppError('Payment not found', 404, true, 'PAYMENT_NOT_FOUND');
        if (payment.status === 'SUCCESS' || payment.status === 'REVERSED') {
          return { alreadyProcessed: true as const };
        }
        if (!payment.user.wallet || !payment.transactionId) {
          throw new AppError('Invalid payment state', 500, true, 'INVALID_STATE');
        }

        const paymentAmount = payment.amount;
        const verifiedAmount = verified.amountKobo;
        if (paymentAmount !== verifiedAmount) {
          const diff =
            paymentAmount > verifiedAmount
              ? paymentAmount - verifiedAmount
              : verifiedAmount - paymentAmount;
          if (diff > 1n) {
            logger.error('Payment amount mismatch', {
              paymentId,
              paymentAmount: paymentAmount.toString(),
              verifiedAmount: verifiedAmount.toString(),
            });
            throw new AppError('Payment amount mismatch', 409, true, 'AMOUNT_MISMATCH');
          }
        }

        const creditAmount =
          paymentAmount < verifiedAmount ? paymentAmount : verifiedAmount;
        if (creditAmount <= 0n) {
          throw new AppError('Invalid credit amount', 400, true, 'INVALID_AMOUNT');
        }

        const { newBalance } = await walletService.creditInTransaction(tx, {
          walletId: payment.user.wallet.id,
          transactionId: payment.transactionId,
          amountKobo: creditAmount,
          description: `Wallet funding via ${payment.provider}`,
          metadata: { providerReference: verified.providerReference },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'SUCCESS',
            providerReference: verified.providerReference,
            paidAt: verified.paidAt ?? new Date(),
            paymentMethod: verified.channel ?? null,
          },
        });

        await tx.transaction.update({
          where: { id: payment.transactionId },
          data: {
            status: 'SUCCESS',
            providerReference: verified.providerReference,
            completedAt: new Date(),
            amount: creditAmount,
          },
        });

        return {
          alreadyProcessed: false as const,
          phoneNumber: payment.user.phoneNumber,
          amountKobo: creditAmount,
          newBalance,
          userId: payment.userId,
          paymentId: payment.id,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      }
    );

    if (result.alreadyProcessed) return { alreadyProcessed: true };

    if ('phoneNumber' in result && result.phoneNumber) {
      await whatsappClient.sendText(
        result.phoneNumber,
        `✅ *Payment Successful*\n\nAmount: *${formatKobo(result.amountKobo!)}*\nNew Balance: *${formatKobo(result.newBalance!)}*\n\nType *menu* to continue.`
      );
      await writeAudit({
        userId: result.userId,
        action: 'WALLET_CREDITED',
        resource: 'payment',
        resourceId: result.paymentId,
        metadata: { amountKobo: result.amountKobo!.toString() },
      });
    }

    return { alreadyProcessed: false };
  }

  async markPaymentFailed(providerReference: string, reason: string): Promise<void> {
    const payment = await prisma.payment.findFirst({
      where: {
        provider: 'PAYSTACK',
        OR: [
          { providerReference },
          { transaction: { externalReference: providerReference } },
        ],
      },
      include: { user: true },
    });
    if (!payment) return;
    if (payment.status === 'SUCCESS' || payment.status === 'REVERSED') return;

    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: reason },
      }),
      prisma.transaction.update({
        where: { id: payment.transactionId! },
        data: { status: 'FAILED', failureReason: reason },
      }),
    ]);

    if (payment.user?.phoneNumber) {
      await whatsappClient.sendText(
        payment.user.phoneNumber,
        `❌ *Payment Failed*\n\n${reason}\n\nNo money was added. Type *menu* to try again.`
      );
    }
  }

  async processReversal(providerReference: string, reason: string): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { provider: 'PAYSTACK', providerReference, status: 'SUCCESS' },
          include: { user: { include: { wallet: true } } },
        });
        if (!payment?.user.wallet || !payment.transactionId) return;

        const cas = await tx.payment.updateMany({
          where: { id: payment.id, status: 'SUCCESS' },
          data: { status: 'REVERSED', failureReason: reason },
        });
        if (cas.count === 0) return;

        const reversal = await tx.transaction.create({
          data: {
            userId: payment.userId,
            type: 'REVERSAL',
            status: 'SUCCESS',
            amount: payment.amount,
            currency: 'NGN',
            description: `Reversal: ${reason}`,
            idempotencyKey: `rev_${payment.id}_${randomUUID()}`,
            provider: this.provider.name,
            providerReference: `rev_${providerReference}`,
            completedAt: new Date(),
          },
        });

        await walletService.debitInTransaction(tx, {
          walletId: payment.user.wallet.id,
          transactionId: reversal.id,
          amountKobo: payment.amount,
          description: 'Reversal of funding',
        });

        await tx.transaction.update({
          where: { id: payment.transactionId },
          data: { status: 'REVERSED', failureReason: reason },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }
    );
  }
}

export const fundingService = new FundingService();