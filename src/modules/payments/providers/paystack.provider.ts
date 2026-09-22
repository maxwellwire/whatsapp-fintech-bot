import crypto from 'crypto';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import type {
  PaymentProvider,
  InitializePaymentInput,
  InitializePaymentResult,
  VerifyPaymentResult,
} from './types.js';

const BASE = 'https://api.paystack.co';

export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = 'PAYSTACK';

  private get secret(): string {
    return env.PAYSTACK_SECRET_KEY;
  }

  private get webhookSecret(): string {
    return env.PAYSTACK_WEBHOOK_SECRET || env.PAYSTACK_SECRET_KEY;
  }

  async initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    try {
      const res = await fetch(`${BASE}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: input.email,
          amount: Number(input.amountKobo),
          reference: input.reference,
          callback_url: input.callbackUrl,
          metadata: input.metadata ?? {},
        }),
      });

      const data = (await res.json()) as {
        status: boolean;
        message: string;
        data?: { authorization_url: string; reference: string };
      };

      if (!res.ok || !data.status || !data.data) {
        return { success: false, message: data.message || 'Init failed' };
      }

      return {
        success: true,
        authorizationUrl: data.data.authorization_url,
        providerReference: data.data.reference,
      };
    } catch (error) {
      logger.error('Paystack initialize error', error);
      return { success: false, message: 'Unable to reach payment provider' };
    }
  }

  async verifyPayment(providerReference: string): Promise<VerifyPaymentResult> {
    try {
      const res = await fetch(
        `${BASE}/transaction/verify/${encodeURIComponent(providerReference)}`,
        { headers: { Authorization: `Bearer ${this.secret}` } }
      );

      const data = (await res.json()) as {
        status: boolean;
        message: string;
        data?: {
          status: string;
          amount: number;
          currency: string;
          reference: string;
          paid_at?: string;
          channel?: string;
        };
      };

      if (!res.ok || !data.status || !data.data) {
        return {
          success: false,
          status: 'unknown',
          amountKobo: 0n,
          currency: 'NGN',
          providerReference,
          raw: data,
        };
      }

      const map: Record<string, VerifyPaymentResult['status']> = {
        success: 'success',
        failed: 'failed',
        abandoned: 'abandoned',
        reversed: 'reversed',
        ongoing: 'pending',
        pending: 'pending',
        processing: 'pending',
      };

      const st = map[data.data.status] ?? 'unknown';

      return {
        success: st === 'success',
        status: st,
        amountKobo: BigInt(data.data.amount),
        currency: data.data.currency || 'NGN',
        providerReference: data.data.reference,
        paidAt: data.data.paid_at ? new Date(data.data.paid_at) : undefined,
        channel: data.data.channel,
        raw: data.data,
      };
    } catch (error) {
      logger.error('Paystack verify error', error);
      return {
        success: false,
        status: 'unknown',
        amountKobo: 0n,
        currency: 'NGN',
        providerReference,
      };
    }
  }

  verifyWebhookSignature(payload: Buffer | string, signature: string): boolean {
    if (!signature) return false;
    const hash = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(typeof payload === 'string' ? payload : payload)
      .digest('hex');
    try {
      const a = Buffer.from(hash);
      const b = Buffer.from(signature);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

export const paystackPaymentProvider = new PaystackPaymentProvider();