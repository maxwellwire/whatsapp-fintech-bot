export interface Bank {
  code: string;
  name: string;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName?: string;
}

export interface InitiateTransferInput {
  amountKobo: bigint;
  accountNumber: string;
  bankCode: string;
  accountName: string;
  narration: string;
  reference: string;
}

export interface InitiateTransferResult {
  success: boolean;
  status: 'success' | 'pending' | 'failed' | 'unknown';
  providerReference?: string;
  sessionId?: string;
  message?: string;
}

export interface VerifyTransferResult {
  success: boolean;
  status: 'success' | 'pending' | 'failed' | 'reversed' | 'unknown';
  providerReference?: string;
  sessionId?: string;
  amountKobo?: bigint;
  message?: string;
}

export interface TransferProvider {
  readonly name: string;
  listBanks(): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount | null>;
  initiateTransfer(input: InitiateTransferInput): Promise<InitiateTransferResult>;
  verifyTransfer(providerReference: string): Promise<VerifyTransferResult>;
}