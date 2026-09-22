import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { walletService } from '../wallets/wallet.service.js';
import { whatsappClient } from '../whatsapp/client.js';
import { formatKobo } from '../../utils/money.js';
import { normalizePhoneNumber } from '../users/user.service.js';
import { writeAudit } from '../shared/audit.js';
import { vtpassDataProvider } from './providers/vtpass.provider.js';
import type { DataPlan, DataProvider, NetworkCode } from './providers/types.js';
import type { UserWithWallet } from '../users/user.service.js';

const LABELS: Record<NetworkCode, string> = {
  mtn: 'MTN',
  airtel: 'Airtel',
  glo: 'Glo',
  etisalat: '9mobile',
};

export class DataService {
  constructor(private readonly provider: DataProvider = vtpassDataProvider) {}

  listPlans(network: NetworkCode) {
    return this.provider.listPlans(network);
  }

  async purchase(input: {
    user: UserWithWallet;
    network: NetworkCode;
    phoneNumber: string;
    plan: DataPlan;
  }): Promise<void> {
    const { user, network, plan } = input;
    const phone = normalizePhoneNumber(input.phoneNumber);
    const amountKobo = plan.amountKobo;

    if (!user.wallet) throw new AppError('No wallet', 400, true, 'NO_WALLET');
    if (user.wallet.balance < amountKobo) {
      throw new AppError(
        `Insufficient balance. Available: ${formatKobo(user.wallet.balance)}`,
        400,
        true,
        'INSUFFICIENT_BALANCE'
      );
    }

    const requestId = `NB${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const idempotencyKey = `data_${user.id}_${randomUUID()}`;

    const { transactionId, dataId } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

        const transaction = await tx.transaction.create({
          data: {
            userId: user.id,
            type: 'DATA',
            status: 'PENDING',
            amount: amountKobo,
            fee: 0n,
            description: `Data ${LABELS[network]} ${plan.planName}`,
            idempotencyKey,
            externalReference: requestId,
            provider: this.provider.name,
          },
        });

        const dataPurchase = await tx.dataPurchase.create({
          data: {
            transactionId: transaction.id,
            phoneNumber: phone,
            network: { mtn: 'MTN', airtel: 'AIRTEL', glo: 'GLO', etisalat: 'NINE_MOBILE' }[network] as
              | 'MTN'
              | 'AIRTEL'
              | 'GLO'
              | 'NINE_MOBILE',
            planCode: plan.planCode,
            planName: plan.planName,
            amount: amountKobo,
            dataVolume: plan.dataVolume,
            validity: plan.validity,
            provider: this.provider.name,
            status: 'PENDING',
            metadata: { requestId },
          },
        });

        await walletService.debitInTransaction(tx, {
          walletId: user.wallet!.id,
          transactionId: transaction.id,
          amountKobo,
          description: `Data ${plan.planName}`,
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'PROCESSING' },
        });

        return { transactionId: transaction.id, dataId: dataPurchase.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }
    );

    const result = await this.provider.purchase({
      network,
      phoneNumber: phone,
      planCode: plan.planCode,
      amountKobo,
      requestId,
    });

    if (result.status === 'success') {
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: transactionId },
          data: {
            status: 'SUCCESS',
            providerReference: result.providerReference,
            completedAt: new Date(),
          },
        }),
        prisma.dataPurchase.update({
          where: { id: dataId },
          data: { status: 'SUCCESS', providerReference: result.providerReference },
        }),
      ]);

      const wallet = await prisma.wallet.findFirst({
        where: { user: { phoneNumber: user.phoneNumber } },
      });

      await whatsappClient.sendText(
        user.phoneNumber,
        `✅ *Data Successful*\n\nNetwork: *${LABELS[network]}*\nPlan: *${plan.planName}*\nAmount: *${formatKobo(amountKobo)}*\n${wallet ? `Balance: *${formatKobo(wallet.balance)}*\n` : ''}\nType *menu*.`
      );
      await writeAudit({
        userId: user.id,
        action: 'DATA_SUCCESS',
        resource: 'transaction',
        resourceId: transactionId,
      });
      return;
    }

    if (result.status === 'pending') {
      await whatsappClient.sendText(
        user.phoneNumber,
        `⏳ Data purchase processing. Ref: \`${requestId}\``
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      const cas = await tx.transaction.updateMany({
        where: { id: transactionId, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'FAILED', failureReason: result.message },
      });
      if (cas.count === 0) return;

      const reversal = await tx.transaction.create({
        data: {
          userId: user.id,
          type: 'REVERSAL',
          status: 'SUCCESS',
          amount: amountKobo,
          description: `Refund data: ${result.message}`,
          idempotencyKey: `rev_data_${transactionId}_${randomUUID()}`,
          provider: this.provider.name,
          completedAt: new Date(),
        },
      });

      await walletService.creditInTransaction(tx, {
        walletId: user.wallet!.id,
        transactionId: reversal.id,
        amountKobo,
        description: 'Refund failed data',
      });

      await tx.dataPurchase.update({
        where: { id: dataId },
        data: { status: 'FAILED' },
      });
    });

    await whatsappClient.sendText(
      user.phoneNumber,
      `❌ *Data Failed*\n\n${result.message || 'Failed'}\nWallet refunded.\n\nType *menu*.`
    );
  }
}

export const dataService = new DataService();