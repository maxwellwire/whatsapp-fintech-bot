import express, { Application, Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

export function createApp(): Application {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.NODE_ENV === 'production' ? false : true,
      methods: ['GET', 'POST'],
    })
  );

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.use(
    express.json({
      verify: (req: Request, _res, buf) => {
        if (
          req.originalUrl?.startsWith('/webhooks/whatsapp') ||
          req.originalUrl?.startsWith('/webhooks/payments')
        ) {
          req.rawBody = buf;
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });

  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}