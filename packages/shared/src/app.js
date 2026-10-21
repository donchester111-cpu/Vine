import crypto from 'node:crypto';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { errorHandler, notFound } from './errors.js';
import { getAllowedOrigins } from './db.js';

/**
 * Build an IP key that works behind Cloudflare's Workers HTTP adapter.
 * Express req.ip can be undefined in this runtime, so prefer the edge-provided
 * CF-Connecting-IP header and normalize IPv6 addresses to a /56 subnet. When
 * running outside Cloudflare, fall back to Express's req.ip. If neither exists,
 * use one shared fail-closed bucket rather than allowing every request a fresh key.
 */
export function createRateLimiter(options = {}) {
  return rateLimit({
    ...options,
    keyGenerator(req) {
      const headerValue = req.get?.('cf-connecting-ip') ?? req.headers?.['cf-connecting-ip'];
      const cloudflareIp = typeof headerValue === 'string' ? headerValue.trim() : '';
      if (cloudflareIp) return ipKeyGenerator(cloudflareIp, 56);

      const requestIp = req.ip;
      if (typeof requestIp === 'string' && requestIp.trim()) {
        return ipKeyGenerator(requestIp.trim(), 56);
      }

      return 'vine:client-ip-unavailable';
    }
  });
}

export function applySecurity(app, options = {}) {
  const allowedOrigins = options.allowedOrigins || getAllowedOrigins();
  app.disable('x-powered-by');
  // Keep proxy support for non-Cloudflare deployments; createRateLimiter prefers CF-Connecting-IP on Workers.
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
  app.use(createRateLimiter({ windowMs: 60_000, limit: options.requestLimit || 120, standardHeaders: 'draft-8', legacyHeaders: false }));
}

export function finishApp(app) {
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export function sendHealth(req, res) {
  res.status(200).json({ status: 'ok', service: process.env.SERVICE_NAME || 'vine-api', requestId: req.id, timestamp: new Date().toISOString() });
}
