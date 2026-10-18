import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const OWNER_ISSUER = 'vine-accounts-api';
const OWNER_AUDIENCE = 'vineowner';
const OWNER_TOKEN_TYPE = 'vine-owner-session';
const OWNER_SESSION_SECONDS = 2 * 60 * 60;

function ownerSecret(env = process.env) {
  const secret = String(env.OWNER_SESSION_SECRET || '');
  return Buffer.byteLength(secret, 'utf8') >= 32 ? secret : null;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createOwnerSessionToken({ id, email }, env = process.env, now = Math.floor(Date.now() / 1000)) {
  const secret = ownerSecret(env);
  if (!secret) throw new HttpError(503, 'OWNER_SESSION_NOT_CONFIGURED', 'Owner sessions are not configured securely on the server.');
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpError(503, 'OWNER_ID_NOT_CONFIGURED', 'The configured owner identity is invalid.');
  }
  const payload = Buffer.from(JSON.stringify({
    iss: OWNER_ISSUER,
    aud: OWNER_AUDIENCE,
    typ: OWNER_TOKEN_TYPE,
    sub: id,
    email: email.trim().toLowerCase(),
    iat: now,
    exp: now + OWNER_SESSION_SECONDS
  })).toString('base64url');
  const unsigned = `v1.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return { accessToken: `${unsigned}.${signature}`, expiresAt: now + OWNER_SESSION_SECONDS };
}

export function verifyOwnerSessionToken(token, env = process.env, now = Math.floor(Date.now() / 1000)) {
  const secret = ownerSecret(env);
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest();
  let received;
  try { received = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (!safeEqual(expected, received)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (claims?.iss !== OWNER_ISSUER || claims?.aud !== OWNER_AUDIENCE || claims?.typ !== OWNER_TOKEN_TYPE) return null;
  if (typeof claims.sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub)) return null;
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return null;
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 60 || claims.exp <= now || claims.exp - claims.iat > OWNER_SESSION_SECONDS) return null;
  return claims;
}

export function requireAuth(authClient) {
  return async function authenticate(req, _res, next) {
    try {
      const header = req.get('authorization') || '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in to continue.');

      // A server-signed token is accepted only as a short-lived Vineowner session.
      // Invalid/custom tokens still fall through to normal Supabase customer authentication.
      const ownerClaims = verifyOwnerSessionToken(match[1]);
      if (ownerClaims) {
        // Owner sessions may access only the owner console and its explicitly enumerated
        // server-side admin surfaces. They remain unusable for customer accounts, checkout,
        // reviews, and payment endpoints. Each admin route still applies the shared staff RBAC.
        const ownerAdminPrefixes = [
          '/api/v1/admin/products', '/api/v1/admin/categories', '/api/v1/admin/suppliers',
          '/api/v1/admin/supplier-products', '/api/v1/admin/orders', '/api/v1/admin/deliveries',
          '/api/v1/admin/analytics/', '/api/v1/admin/notifications', '/api/v1/admin/questions',
          '/api/v1/admin/product-images'
        ];
        const allowedOwnerPath = req.path.startsWith('/api/v1/owner/') ||
          req.path === '/api/v1/auth/logout' || ownerAdminPrefixes.some(prefix =>
            req.path === prefix || (prefix.endsWith('/') ? req.path.startsWith(prefix) : req.path.startsWith(`${prefix}/`))
          );
        if (!allowedOwnerPath) throw new HttpError(403, 'OWNER_SESSION_SCOPE', 'This owner session cannot be used for that endpoint.');
        const configuredEmail = String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
        const configuredId = String(process.env.VINE_OWNER_USER_ID || '').trim().toLowerCase();
        if (ownerClaims.email !== configuredEmail || !configuredId || ownerClaims.sub.toLowerCase() !== configuredId) {
          throw new HttpError(401, 'INVALID_OWNER_SESSION', 'This owner session is no longer valid. Please sign in again.');
        }
        req.user = { id: ownerClaims.sub, email: ownerClaims.email, user_metadata: { full_name: 'Vine Owner' }, app_metadata: { provider: 'vine-server-owner' } };
        req.accessToken = match[1];
        req.authType = 'owner-server';
        return next();
      }

      const { data, error } = await authClient.auth.getUser(match[1]);
      if (error || !data?.user) throw new HttpError(401, 'INVALID_SESSION', 'Your session is invalid or expired. Please sign in again.');
      req.user = data.user;
      req.accessToken = match[1];
      req.authType = 'supabase';
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRoles(accountsAdmin, allowedRoles = ['owner', 'admin']) {
  return async function authorize(req, _res, next) {
    try {
      if (!accountsAdmin) throw new HttpError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Administrator authorization is not configured.');
      const { data, error } = await accountsAdmin.from('admin_roles')
        .select('role').eq('user_id', req.user?.id).in('role', allowedRoles);
      if (error) throw new HttpError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Administrator authorization could not be checked.');
      if (!data?.length) throw new HttpError(403, 'ADMIN_REQUIRED', 'You do not have permission to perform this action.');
      req.adminRoles = data.map(row => row.role);
      next();
    } catch (error) { next(error); }
  };
}

export function isSupabaseError(result) {
  return Boolean(result?.error);
}
