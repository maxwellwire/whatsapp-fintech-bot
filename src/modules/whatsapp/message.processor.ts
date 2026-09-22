import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../utils/logger.js';
import { userService } from '../users/user.service.js';
import { menuHandler } from '../conversation/menu.handler.js';
import { whatsappClient } from './client.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { IncomingWhatsAppMessage, WhatsAppWebhookPayload } from './types.js';

const locks = new Map<string, Promise<void>>();

async function withUserLock(phone: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(phone) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  locks.set(
    phone,
    prev.then(() => gate)
  );
  await prev;
  try {
    await fn();
  } finally {
    release();
    if (locks.get(phone) === gate) locks.delete(phone);
  }
}

export class MessageProcessor {
  async processWebhookPayload(payload: WhatsAppWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          await this.processMessage(message, value.contacts?.[0]?.profile?.name);
        }
      }
    }
  }

  private async processMessage(
    message: IncomingWhatsAppMessage,
    profileName?: string
  ): Promise<void> {
    const phoneNumber = message.from;
    const messageId = message.id;

    // Dedupe WhatsApp deliveries
    try {
      await prisma.webhookEvent.create({
        data: {
          provider: 'whatsapp',
          eventId: messageId,
          eventType: 'message',
          payload: message as object,
          processed: false,
        },
      });
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        logger.info('Duplicate WhatsApp message ignored', { messageId });
        return;
      }
      throw error;
    }

    await withUserLock(phoneNumber, async () => {
      try {
        await whatsappClient.markAsRead(messageId);

        if (message.type !== 'text' || !('text' in message) || !message.text?.body) {
          await whatsappClient.sendText(
            phoneNumber,
            'Please send a text message. Type *menu*.'
          );
          return;
        }

        const text = message.text.body.trim();
        const user = await userService.findOrCreate(phoneNumber, profileName);
        await menuHandler.handleIncoming(user, phoneNumber, text);

        await prisma.webhookEvent.update({
          where: { provider_eventId: { provider: 'whatsapp', eventId: messageId } },
          data: { processed: true, processedAt: new Date() },
        });
      } catch (error) {
        logger.error('processMessage failed', { messageId, error });
        const msg =
          error instanceof AppError
            ? error.message
            : 'Something went wrong. Type *menu*.';
        await whatsappClient.sendText(phoneNumber, `⚠️ ${msg}`);
      }
    });
  }
}

export const messageProcessor = new MessageProcessor();