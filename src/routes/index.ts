import { Router } from 'express';
import healthRouter from './health.js';
import whatsappWebhookRouter from './webhooks/whatsapp.js';
import paymentsWebhookRouter from './webhooks/payments.js';

const router = Router();
router.use('/health', healthRouter);
router.use('/webhooks/whatsapp', whatsappWebhookRouter);
router.use('/webhooks/payments', paymentsWebhookRouter);

export default router;