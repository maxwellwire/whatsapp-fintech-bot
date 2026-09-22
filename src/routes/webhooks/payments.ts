import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { paystackPaymentProvider } from '../../modules/payments/providers/paystack.provider.js';
import { paymentWebhookHandler } from '../../modules/payments/payment.webhook.handler.js';

const router = Router();

router.post('/paystack', (req: Request, res: Response) => {
  const signature = (req.headers['x-paystack-signature'] as string) || '';
  const rawBody = req.rawBody;

  if (!rawBody || !paystackPaymentProvider.verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Invalid Paystack signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  res.status(200).json({ received: true });

  setImmediate(() => {
    paymentWebhookHandler
      .handlePaystackWebhook(rawBody, signature, req.body)
      .catch((err) => logger.error('Paystack webhook error', err));
  });
});

export default router;