import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().email().max(254).transform(value => value.toLowerCase());
export const phoneSchema = z.string().trim().min(7).max(30).regex(/^[+0-9() .-]+$/);
export const safeText = (max = 200) => z.string().trim().min(1).max(max);
export const optionalText = (max = 200) => z.string().trim().max(max).optional().or(z.literal(''));

export function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeProductQuery(text) {
  return String(text || '').replace(/[%,()_*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function asSafeError(error, context) {
  if (error?.message) console.error(JSON.stringify({ level: 'error', context, message: error.message }));
}
