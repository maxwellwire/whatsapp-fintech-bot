export type NetworkCode = 'mtn' | 'airtel' | 'glo' | 'etisalat';

export interface PurchaseAirtimeInput {
  network: NetworkCode;
  phoneNumber: string;
  amountKobo: bigint;
  requestId: string;
}

export interface PurchaseAirtimeResult {
  success: boolean;
  status: 'success' | 'pending' | 'failed' | 'unknown';
  providerReference?: string;
  requestId: string;
  message?: string;
}

export interface AirtimeProvider {
  readonly name: string;
  purchase(input: PurchaseAirtimeInput): Promise<PurchaseAirtimeResult>;
  queryStatus(requestId: string): Promise<PurchaseAirtimeResult>;
}