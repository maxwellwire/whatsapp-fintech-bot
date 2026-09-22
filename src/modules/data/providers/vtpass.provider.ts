import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import type {
  DataProvider,
  DataPlan,
  NetworkCode,
  PurchaseDataInput,
  PurchaseDataResult,
} from './types.js';

const SERVICE: Record<NetworkCode, string> = {
  mtn: 'mtn-data',
  airtel: 'airtel-data',
  glo: 'glo-data',
  etisalat: 'etisalat-data',
};

const FALLBACK: Record<NetworkCode, DataPlan[]> = {
  mtn: [
    { planCode: 'mtn-1gb', planName: '1GB', amountKobo: 50000n, dataVolume: '1GB', validity: '30 days', network: 'mtn' },
    { planCode: 'mtn-2gb', planName: '2GB', amountKobo: 100000n, dataVolume: '2GB', validity: '30 days', network: 'mtn' },
    { planCode: 'mtn-5gb', planName: '5GB', amountKobo: 200000n, dataVolume: '5GB', validity: '30 days', network: 'mtn' },
  ],
  airtel: [
    { planCode: 'airtel-1gb', planName: '1GB', amountKobo: 50000n, dataVolume: '1GB', validity: '30 days', network: 'airtel' },
    { planCode: 'airtel-2gb', planName: '2GB', amountKobo: 100000n, dataVolume: '2GB', validity: '30 days', network: 'airtel' },
  ],
  glo: [
    { planCode: 'glo-1gb', planName: '1GB', amountKobo: 50000n, dataVolume: '1GB', validity: '30 days', network: 'glo' },
    { planCode: 'glo-2gb', planName: '2GB', amountKobo: 100000n, dataVolume: '2GB', validity: '30 days', network: 'glo' },
  ],
  etisalat: [
    { planCode: '9m-1gb', planName: '1GB', amountKobo: 50000n, dataVolume: '1GB', validity: '30 days', network: 'etisalat' },
  ],
};

export class VTPassDataProvider implements DataProvider {
  readonly name = 'VTPASS';
  private cache = new Map<NetworkCode, { plans: DataPlan[]; at: number }>();

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

  async listPlans(network: NetworkCode): Promise<DataPlan[]> {
    const cached = this.cache.get(network);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.plans;

    try {
      const res = await fetch(
        `${env.VTPASS_BASE_URL.replace(/\/$/, '')}/service-variations?serviceID=${SERVICE[network]}`,
        { headers: this.headers() }
      );
      const data = (await res.json()) as {
        content?: {
          varations?: Array<{ variation_code: string; name: string; variation_amount: string }>;
        };
      };
      const vars = data.content?.varations ?? [];
      if (!vars.length) return FALLBACK[network];

      const plans: DataPlan[] = vars
        .map((v) => {
          const naira = Number(v.variation_amount);
          if (!Number.isFinite(naira) || naira <= 0) return null;
          return {
            planCode: v.variation_code,
            planName: v.name,
            amountKobo: BigInt(Math.round(naira * 100)),
            dataVolume: v.name,
            validity: '',
            network,
          } satisfies DataPlan;
        })
        .filter((p): p is DataPlan => p !== null)
        .slice(0, 12);

      this.cache.set(network, { plans, at: Date.now() });
      return plans;
    } catch (error) {
      logger.error('listPlans failed', error);
      return FALLBACK[network];
    }
  }

  async purchase(input: PurchaseDataInput): Promise<PurchaseDataResult> {
    try {
      const res = await fetch(`${env.VTPASS_BASE_URL.replace(/\/$/, '')}/pay`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          request_id: input.requestId,
          serviceID: SERVICE[input.network],
          billersCode: this.localPhone(input.phoneNumber),
          variation_code: input.planCode,
          amount: Number(input.amountKobo) / 100,
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
      logger.error('data purchase error', error);
      return {
        success: false,
        status: 'unknown',
        requestId: input.requestId,
        message: 'Provider unreachable',
      };
    }
  }

  async queryStatus(requestId: string): Promise<PurchaseDataResult> {
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
        };
      }
      if (code === '099' || st === 'pending') {
        return { success: false, status: 'pending', requestId };
      }
      return {
        success: false,
        status: 'failed',
        requestId,
        message: data.response_description,
      };
    } catch {
      return { success: false, status: 'unknown', requestId };
    }
  }
}

export const vtpassDataProvider = new VTPassDataProvider();