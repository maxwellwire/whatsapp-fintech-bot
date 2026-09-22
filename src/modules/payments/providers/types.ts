export interface InitializePaymentInput {
  amountKobo: bigint;
  email: string;
  reference: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
}

export interface InitializePaymentResult {
  success: boolean;
  authorizationUrl?: string;
  providerReference?: string;
  message?: string;
}

export interface VerifyPaymentResult {
  success: boolean;
  status: 'success' | 'failed' | 'pending' | 'abandoned' | 'reversed' | 'unknown';
  amountKobo: bigint;
  currency: string;
  providerReference: string;
  paidAt?: Date;
  channel?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult>;
  verifyPayment(providerReference: string): Promise<VerifyPaymentResult>;
  verifyWebhookSignature(payload: Buffer | string, signature: string): boolean;
}