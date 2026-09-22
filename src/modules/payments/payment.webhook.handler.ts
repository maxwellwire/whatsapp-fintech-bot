import { prisma } from '../../infrastructure/database/prisma.js';
import { logger } from '../../utils/logger.js';
import { paystackPaymentProvider } from './providers/paystack.provider.js';
import { fundingService } from './funding.service.js';

interface PaystackWebhookBody {
  event: string;
  data: {
    id?: number | string;
    reference: string;
    status?: string;
    amount?: number;
    paid_at?: string;
    channel?: string;
    [key: string]: unknown;
  };
}

export class PaymentWebhookHandler {
  async handlePaystackWebhook(
    rawBody: Buffer,
    signature: string,
    body: PaystackWebhookBody
  ): Promise<void> {
    if (!paystackPaymentProvider.verifyWebhookSignature(rawBody, signature)) {
      throw new Error('Invalid signature');
    }

    const reference = body.data?.reference;
    if (!reference) {
      logger.warn('Webhook missing reference');
      return;
    }

    // Stable event id — never use Date.now()
    const eventId = body.data?.id
      ? String(body.data.id)
      : `${body.event}:${reference}`;

    try {
      await prisma.webhookEvent.create({
        data: {
          provider: 'paystack',
          eventId,
          eventType: body.event,
          payload: body as object,
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
        logger.info('Duplicate webhook ignored', { eventId });
        return;
      }
      throw error;
    }

    try {
      await this.route(body);
      await prisma.webhookEvent.update({
        where: { provider_eventId: { provider: 'paystack', eventId } },
        data: { processed: true, processedAt: new Date() },
      });
    } catch (error) {
      logger.error('Webhook processing error', { eventId, error });
      await prisma.webhookEvent.update({
        where: { provider_eventId: { provider: 'paystack', eventId } },
        data: { error: error instanceof Error ? error.message : 'Unknown' },
      });
    }
  }

  private async route(body: PaystackWebhookBody): Promise<void> {
    const reference = body.data.reference;

    switch (body.event) {
      case 'charge.success': {
        const verified = await paystackPaymentProvider.verifyPayment(reference);
        if (verified.success && verified.status === 'success') {
          await fundingService.processSuccessfulPayment(reference, verified);
        }
        break;
      }
      case 'charge.failed':
        await fundingService.markPaymentFailed(reference, `Provider: ${body.event}`);
        break;
      case 'refund.processed':
      case 'charge.reversed':
        await fundingService.processReversal(reference, `Provider: ${body.event}`);
        break;
      default:
        logger.debug('Unhandled event', { event: body.event });
    }
  }
}

export const paymentWebhookHandler = new PaymentWebhookHandler();