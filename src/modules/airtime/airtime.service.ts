import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { walletService } from '../wallets/wallet.service.js';
import { whatsappClient } from '../whatsapp/client.js';
import { formatKobo } from '../../utils/money.js';
import { normalizePhoneNumber } from '../users/user.service.js';
import { writeAudit } from '../shared/audit.js';
import { vtpassAirtimeProvider } from './providers/vtpass.provider.js';
import type { AirtimeProvider, NetworkCode } from './providers/types.js';
import type { UserWithWallet } from '../users/user.service.js';

const LABELS: Record<NetworkCode, string> = {
  mtn: 'MTN',
  airtel: 'Airtel',
  glo: 'Glo',
  etisalat: '9mobile',
};

export class AirtimeService {
  constructor(private readonly provider: AirtimeProvider = vtpassAirtimeProvider) {}

  async purchase(input: {
    user: UserWithWallet;
    network: NetworkCode;
    phoneNumber: string;
    amountKobo: bigint;
  }): Promise<void> {
    const { user, network, amountKobo } = input;
    const phone = normalizePhoneNumber(input.phoneNumber);

    if (!user.wallet) throw new AppError('No wallet', 400, true, 'NO_WALLET');
    if (amountKobo < BigInt(env.MIN_AIRTIME_KOBO) || amountKobo > BigInt(env.MAX_AIRTIME_KOBO)) {
      throw new AppError('Amount out of allowed range', 400, true, 'INVALID_AMOUNT');
    }
    if (user.wallet.balance < amountKobo) {
      throw new AppError(
        `Insufficient balance. Available: ${formatKobo(user.wallet.balance)}`,
        400,
        true,
        'INSUFFICIENT_BALANCE'
      );
    }

    const requestId = `NB${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const idempotencyKey = `airtime_${user.id}_${randomUUID()}`;

    const { transactionId, airtimeId } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

        const transaction = await tx.transaction.create({
          data: {
            userId: user.id,
            type: 'AIRTIME',
            status: 'PENDING',
            amount: amountKobo,
            fee: 0n,
            description: `Airtime ${LABELS[network]} ${phone}`,
            idempotencyKey,
            externalReference: requestId,
            provider: this.provider.name,
          },
        });

        const airtime = await tx.airtimePurchase.create({
          data: {
            transactionId: transaction.id,
            phoneNumber: phone,
            network: this.toPrisma(network),
            amount: amountKobo,
            provider: this.provider.name,
            status: 'PENDING',
            metadata: { requestId },
          },
        });

        await walletService.debitInTransaction(tx, {
          walletId: user.wallet!.id,
          transactionId: transaction.id,
          amountKobo,
          description: `Airtime ${LABELS[network]}`,
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'PROCESSING' },
        });

        return { transactionId: transaction.id, airtimeId: airtime.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }
    );

    const result = await this.provider.purchase({
      network,
      phoneNumber: phone,
      amountKobo,
      requestId,
    });

    if (result.status === 'success') {
      await this.markSuccess(transactionId, airtimeId, result.providerReference || requestId, {
        userPhone: user.phoneNumber,
        network,
        recipient: phone,
        amountKobo,
      });
      return;
    }

    if (result.status === 'pending') {
      await prisma.airtimePurchase.update({
        where: { id: airtimeId },
        data: { status: 'PROCESSING', providerReference: result.providerReference },
      });
      await whatsappClient.sendText(
        user.phoneNumber,
        `⏳ Airtime processing for ${LABELS[network]} ${phone}. You will get a confirmation shortly.\nRef: \`${requestId}\``
      );
      return;
    }

    await this.refund(transactionId, airtimeId, user, amountKobo, result.message || 'Failed');
  }

  private async markSuccess(
    transactionId: string,
    airtimeId: string,
    providerReference: string,
    meta: { userPhone: string; network: NetworkCode; recipient: string; amountKobo: bigint }
  ) {
    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: transactionId },
        data: { status: 'SUCCESS', providerReference, completedAt: new Date() },
      }),
      prisma.airtimePurchase.update({
        where: { id: airtimeId },
        data: { status: 'SUCCESS', providerReference },
      }),
    ]);

    const wallet = await prisma.wallet.findFirst({
      where: { user: { phoneNumber: meta.userPhone } },
    });

    await whatsappClient.sendText(
      meta.userPhone,
      `✅ *Airtime Successful*\n\nNetwork: *${LABELS[meta.network]}*\nNumber: *${meta.recipient}*\nAmount: *${formatKobo(meta.amountKobo)}*\n${wallet ? `Balance: *${formatKobo(wallet.balance)}*\n` : ''}\nRef: \`${providerReference}\`\n\nType *menu*.`
    );

    await writeAudit({
      action: 'AIRTIME_SUCCESS',
      resource: 'transaction',
      resourceId: transactionId,
      metadata: { amountKobo: meta.amountKobo.toString() },
    });
  }

  private async refund(
    transactionId: string,
    airtimeId: string,
    user: UserWithWallet,
    amountKobo: bigint,
    reason: string
  ) {
    await prisma.$transaction(
      async (tx) => {
        const cas = await tx.transaction.updateMany({
          where: { id: transactionId, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { status: 'FAILED', failureReason: reason },
        });
        if (cas.count === 0) return;

        const reversal = await tx.transaction.create({
          data: {
            userId: user.id,
            type: 'REVERSAL',
            status: 'SUCCESS',
            amount: amountKobo,
            description: `Refund airtime: ${reason}`,
            idempotencyKey: `rev_air_${transactionId}_${randomUUID()}`,
            provider: this.provider.name,
            completedAt: new Date(),
          },
        });

        await walletService.creditInTransaction(tx, {
          walletId: user.wallet!.id,
          transactionId: reversal.id,
          amountKobo,
          description: 'Refund failed airtime',
        });

        await tx.airtimePurchase.update({
          where: { id: airtimeId },
          data: { status: 'FAILED' },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }
    );

    await whatsappClient.sendText(
      user.phoneNumber,
      `❌ *Airtime Failed*\n\n${reason}\nWallet refunded.\n\nType *menu*.`
    );
  }

  private toPrisma(n: NetworkCode): 'MTN' | 'AIRTEL' | 'GLO' | 'NINE_MOBILE' {
    return { mtn: 'MTN', airtel: 'AIRTEL', glo: 'GLO', etisalat: 'NINE_MOBILE' }[n] as
      | 'MTN'
      | 'AIRTEL'
      | 'GLO'
      | 'NINE_MOBILE';
  }
}

export const airtimeService = new AirtimeService();