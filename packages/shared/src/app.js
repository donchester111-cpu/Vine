import crypto from 'node:crypto';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { errorHandler, notFound } from './errors.js';
import { getAllowedOrigins } from './db.js';

export function applySecurity(app, options = {}) {
  const allowedOrigins = options.allowedOrigins || getAllowedOrigins();
  app.disable('x-powered-by');
  // Render terminates TLS in front of the app; trust its single proxy hop so IP-based rate limits work.
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id']?.toString().slice(0, 100) || crypto.randomUUID();
    res.setHeader('X-Request-ID', req.id);
    next();
  });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not permitted by Vine API CORS policy.'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID', 'X-Vine-Product-Slug'],
    exposedHeaders: ['X-Request-ID'],
    credentials: false,
    maxAge: 600
  }));
  app.use(rateLimit({ windowMs: 60_000, limit: options.requestLimit || 120, standardHeaders: 'draft-8', legacyHeaders: false }));
}

export function finishApp(app) {
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export function sendHealth(req, res) {
  res.status(200).json({ status: 'ok', service: process.env.SERVICE_NAME || 'vine-api', requestId: req.id, timestamp: new Date().toISOString() });
}
