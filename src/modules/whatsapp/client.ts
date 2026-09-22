import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const BASE = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}`;

export class WhatsAppClient {
  async sendText(to: string, body: string): Promise<string | null> {
    const phone = to.replace(/\D/g, '');
    try {
      const res = await fetch(`${BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body },
        }),
      });

      const data = (await res.json()) as {
        messages?: Array<{ id: string }>;
        error?: { message: string };
      };

      if (!res.ok) {
        logger.error('WhatsApp sendText failed', { status: res.status, error: data.error });
        return null;
      }

      const id = data.messages?.[0]?.id ?? null;
      logger.info('WhatsApp message sent', { to: phone, messageId: id });
      return id;
    } catch (error) {
      logger.error('WhatsApp sendText network error', error);
      return null;
    }
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await fetch(`${BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      });
    } catch {
      // best effort
    }
  }
}

export const whatsappClient = new WhatsAppClient();