import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import type {
  AirtimeProvider,
  NetworkCode,
  PurchaseAirtimeInput,
  PurchaseAirtimeResult,
} from './types.js';

const SERVICE: Record<NetworkCode, string> = {
  mtn: 'mtn',
  airtel: 'airtel',
  glo: 'glo',
  etisalat: 'etisalat',
};

export class VTPassAirtimeProvider implements AirtimeProvider {
  readonly name = 'VTPASS';

  private headers() {
    return {
      'api-key': env.VTPASS_API_KEY,
      'public-key': env.VTPASS_PUBLIC_KEY || '',
      'secret-key': env.VTPASS_SECRET_KEY || env.VTPASS_API_KEY,
      'Content-Type': 'application/json',
    };
  }

  private localPhone(phone: string): string {
    const d = phone.replace(/\D/g, '');
    if (d.startsWith('234') && d.length === 13) return '0' + d.slice(3);
    if (d.length === 10) return '0' + d;
    return d;
  }

  async purchase(input: PurchaseAirtimeInput): Promise<PurchaseAirtimeResult> {
    const serviceID = SERVICE[input.network];
    const amountNaira = Number(input.amountKobo) / 100;
    try {
      const res = await fetch(`${env.VTPASS_BASE_URL.replace(/\/$/, '')}/pay`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          request_id: input.requestId,
          serviceID,
          amount: amountNaira,
          phone: this.localPhone(input.phoneNumber),
        }),
      });
      const data = (await res.json()) as {
        code?: string;
        response_description?: string;
        transactionId?: string | number;
      };
      const code = String(data.code ?? '');
      if (code === '000') {
        return {
          success: true,
          status: 'success',
          providerReference: String(data.transactionId ?? input.requestId),
          requestId: input.requestId,
          message: data.response_description,
        };
      }
      if (code === '099' || code === '01') {
        return {
          success: false,
          status: 'pending',
          providerReference: String(data.transactionId ?? input.requestId),
          requestId: input.requestId,
          message: data.response_description,
        };
      }
      return {
        success: false,
        status: 'failed',
        requestId: input.requestId,
        message: data.response_description || `Code ${code}`,
      };
    } catch (error) {
      logger.error('VTPass airtime error', error);
      return {
        success: false,
        status: 'unknown',
        requestId: input.requestId,
        message: 'Provider unreachable',
      };
    }
  }

  async queryStatus(requestId: string): Promise<PurchaseAirtimeResult> {
    try {
      const res = await fetch(`${env.VTPASS_BASE_URL.replace(/\/$/, '')}/requery`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ request_id: requestId }),
      });
      const data = (await res.json()) as {
        code?: string;
        response_description?: string;
        content?: { transactions?: { status?: string; transactionId?: string | number } };
      };
      const code = String(data.code ?? '');
      const st = data.content?.transactions?.status?.toLowerCase();
      if (code === '000' || st === 'delivered' || st === 'successful') {
        return {
          success: true,
          status: 'success',
          providerReference: String(data.content?.transactions?.transactionId ?? requestId),
          requestId,
          message: data.response_description,
        };
      }
      if (code === '099' || st === 'pending' || st === 'processing') {
        return { success: false, status: 'pending', requestId, message: data.response_description };
      }
      return {
        success: false,
        status: 'failed',
        requestId,
        message: data.response_description || 'Failed',
      };
    } catch {
      return { success: false, status: 'unknown', requestId, message: 'Requery failed' };
    }
  }
}

export const vtpassAirtimeProvider = new VTPassAirtimeProvider();