import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import type {
  TransferProvider,
  Bank,
  ResolvedAccount,
  InitiateTransferInput,
  InitiateTransferResult,
  VerifyTransferResult,
} from './types.js';

const BASE = 'https://api.paystack.co';

export const POPULAR_BANKS: Bank[] = [
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '057', name: 'Zenith Bank' },
  { code: '044', name: 'Access Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '035', name: 'Wema Bank' },
];

export class PaystackTransferProvider implements TransferProvider {
  readonly name = 'PAYSTACK';

  async listBanks(): Promise<Bank[]> {
    try {
      const res = await fetch(`${BASE}/bank?country=nigeria&currency=NGN`, {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      });
      const data = (await res.json()) as {
        status: boolean;
        data?: Array<{ code: string; name: string; active: boolean }>;
      };
      if (!data.status || !data.data) return POPULAR_BANKS;
      return data.data.filter((b) => b.active).map((b) => ({ code: b.code, name: b.name }));
    } catch {
      return POPULAR_BANKS;
    }
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount | null> {
    try {
      const url = `${BASE}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      });
      const data = (await res.json()) as {
        status: boolean;
        data?: { account_number: string; account_name: string };
      };
      if (!res.ok || !data.status || !data.data) return null;
      const banks = await this.listBanks();
      const bank = banks.find((b) => b.code === bankCode);
      return {
        accountNumber: data.data.account_number,
        accountName: data.data.account_name,
        bankCode,
        bankName: bank?.name,
      };
    } catch (error) {
      logger.error('resolveAccount error', error);
      return null;
    }
  }

  async initiateTransfer(input: InitiateTransferInput): Promise<InitiateTransferResult> {
    try {
      const recipRes = await fetch(`${BASE}/transferrecipient`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'nuban',
          name: input.accountName,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
          currency: 'NGN',
        }),
      });
      const recip = (await recipRes.json()) as {
        status: boolean;
        message?: string;
        data?: { recipient_code: string };
      };
      if (!recipRes.ok || !recip.status || !recip.data?.recipient_code) {
        return { success: false, status: 'failed', message: recip.message || 'Recipient failed' };
      }

      const trRes = await fetch(`${BASE}/transfer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: Number(input.amountKobo),
          recipient: recip.data.recipient_code,
          reason: input.narration,
          reference: input.reference,
        }),
      });
      const tr = (await trRes.json()) as {
        status: boolean;
        message?: string;
        data?: { transfer_code: string; status: string; reference: string };
      };

      if (!trRes.ok || !tr.status || !tr.data) {
        return { success: false, status: 'failed', message: tr.message || 'Transfer failed' };
      }

      const st = tr.data.status?.toLowerCase();
      // HTTP 200 is NOT proof of success
      if (st === 'success') {
        return {
          success: true,
          status: 'success',
          providerReference: tr.data.transfer_code || tr.data.reference,
        };
      }
      if (st === 'pending' || st === 'otp' || st === 'received') {
        return {
          success: false,
          status: 'pending',
          providerReference: tr.data.transfer_code || tr.data.reference,
          message: tr.message,
        };
      }
      return {
        success: false,
        status: 'failed',
        providerReference: tr.data.transfer_code,
        message: tr.message || st,
      };
    } catch (error) {
      logger.error('initiateTransfer error', error);
      return { success: false, status: 'unknown', message: 'Provider unreachable' };
    }
  }

  async verifyTransfer(providerReference: string): Promise<VerifyTransferResult> {
    try {
      const res = await fetch(
        `${BASE}/transfer/verify/${encodeURIComponent(providerReference)}`,
        { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } }
      );
      const data = (await res.json()) as {
        status: boolean;
        message?: string;
        data?: {
          status: string;
          transfer_code: string;
          reference: string;
          amount: number;
          session?: { id?: string };
        };
      };
      if (!res.ok || !data.status || !data.data) {
        return { success: false, status: 'unknown', message: data.message };
      }
      const st = data.data.status?.toLowerCase();
      if (st === 'success') {
        return {
          success: true,
          status: 'success',
          providerReference: data.data.transfer_code || data.data.reference,
          sessionId: data.data.session?.id,
          amountKobo: BigInt(data.data.amount),
        };
      }
      if (st === 'pending' || st === 'otp' || st === 'received') {
        return {
          success: false,
          status: 'pending',
          providerReference: data.data.transfer_code || data.data.reference,
        };
      }
      if (st === 'reversed' || st === 'refunded') {
        return {
          success: false,
          status: 'reversed',
          providerReference: data.data.transfer_code || data.data.reference,
        };
      }
      return {
        success: false,
        status: 'failed',
        providerReference: data.data.transfer_code || data.data.reference,
        message: data.message,
      };
    } catch {
      return { success: false, status: 'unknown', message: 'Verify failed' };
    }
  }
}

export const paystackTransferProvider = new PaystackTransferProvider();