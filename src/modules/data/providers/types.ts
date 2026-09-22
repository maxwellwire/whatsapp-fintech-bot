import type { NetworkCode } from '../../airtime/providers/types.js';

export type { NetworkCode };

export interface DataPlan {
  planCode: string;
  planName: string;
  amountKobo: bigint;
  dataVolume: string;
  validity: string;
  network: NetworkCode;
}

export interface PurchaseDataInput {
  network: NetworkCode;
  phoneNumber: string;
  planCode: string;
  amountKobo: bigint;
  requestId: string;
}

export interface PurchaseDataResult {
  success: boolean;
  status: 'success' | 'pending' | 'failed' | 'unknown';
  providerReference?: string;
  requestId: string;
  message?: string;
}

export interface DataProvider {
  readonly name: string;
  listPlans(network: NetworkCode): Promise<DataPlan[]>;
  purchase(input: PurchaseDataInput): Promise<PurchaseDataResult>;
  queryStatus(requestId: string): Promise<PurchaseDataResult>;
}