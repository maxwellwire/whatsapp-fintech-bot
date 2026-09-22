import { Router, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { validateWhatsAppSignature } from '../../middleware/validateWhatsAppSignature.js';
import { messageProcessor } from '../../modules/whatsapp/message.processor.js';
import type { WhatsAppWebhookPayload } from '../../modules/whatsapp/types.js';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send('Forbidden');
});

router.post('/', validateWhatsAppSignature, (req: Request, res: Response) => {
  res.status(200).json({ success: true });
  const payload = req.body as WhatsAppWebhookPayload;
  setImmediate(() => {
    messageProcessor.processWebhookPayload(payload).catch((err) => {
      logger.error('WhatsApp processor error', err);
    });
  });
});

export default router;