import { prisma } from '../../infrastructure/database/prisma.js';

const TTL_MS = 30 * 60 * 1000;

export type ConversationState =
  | 'IDLE'
  | 'AWAITING_MENU_SELECTION'
  | 'SET_PIN'
  | 'AIRTIME_AWAITING_NETWORK'
  | 'AIRTIME_AWAITING_PHONE'
  | 'AIRTIME_AWAITING_AMOUNT'
  | 'AIRTIME_AWAITING_CONFIRM'
  | 'AIRTIME_AWAITING_PIN'
  | 'DATA_AWAITING_NETWORK'
  | 'DATA_AWAITING_PHONE'
  | 'DATA_AWAITING_PLAN'
  | 'DATA_AWAITING_CONFIRM'
  | 'DATA_AWAITING_PIN'
  | 'TRANSFER_AWAITING_BANK'
  | 'TRANSFER_AWAITING_ACCOUNT'
  | 'TRANSFER_AWAITING_AMOUNT'
  | 'TRANSFER_AWAITING_CONFIRM'
  | 'TRANSFER_AWAITING_PIN'
  | 'FUND_AWAITING_AMOUNT';

export class SessionService {
  async get(phoneNumber: string): Promise<{
    state: ConversationState;
    context: Record<string, unknown>;
  }> {
    const row = await prisma.conversationSession.findUnique({
      where: { phoneNumber },
    });

    if (!row || row.expiresAt < new Date()) {
      return { state: 'IDLE', context: {} };
    }

    return {
      state: row.state as ConversationState,
      context: (row.context as Record<string, unknown>) ?? {},
    };
  }

  async set(
    userId: string,
    phoneNumber: string,
    state: ConversationState,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    await prisma.conversationSession.upsert({
      where: { phoneNumber },
      create: { userId, phoneNumber, state, context, expiresAt },
      update: { state, context, expiresAt, userId },
    });
  }

  async updateContext(
    userId: string,
    phoneNumber: string,
    partial: Record<string, unknown>
  ): Promise<void> {
    const current = await this.get(phoneNumber);
    await this.set(phoneNumber ? userId : userId, phoneNumber, current.state, {
      ...current.context,
      ...partial,
    });
  }

  async setState(
    userId: string,
    phoneNumber: string,
    state: ConversationState
  ): Promise<void> {
    const current = await this.get(phoneNumber);
    await this.set(userId, phoneNumber, state, current.context);
  }

  async clear(phoneNumber: string): Promise<void> {
    await prisma.conversationSession.deleteMany({ where: { phoneNumber } });
  }

  async resetToMenu(userId: string, phoneNumber: string): Promise<void> {
    await this.set(userId, phoneNumber, 'AWAITING_MENU_SELECTION', {});
  }
}

export const sessionService = new SessionService();