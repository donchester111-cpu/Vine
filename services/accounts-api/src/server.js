import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { applySecurity, finishApp, sendHealth } from '@vine/shared/app';
import { createAuthContext } from '@vine/shared/db';
import { requireAuth } from '@vine/shared/auth';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { emailSchema, optionalText, phoneSchema, safeText, uuidSchema } from '@vine/shared/validation';
import { registerOwnerAdmin } from './owner-admin.js';

process.env.SERVICE_NAME = 'vine-accounts-api';
const { authClient, accountsAdmin } = createAuthContext();
if (!accountsAdmin) throw new Error('ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY is required for vine-accounts-api.');
const app = express();
applySecurity(app, { requestLimit: 120 });
app.use(express.json({ limit: '64kb' }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const auth = requireAuth(authClient);

app.get('/health', sendHealth);
app.get('/ready', asyncRoute(async (req, res) => {
  const { error } = await accountsAdmin.from('profiles').select('user_id').limit(1);
  if (error) throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Vine accounts database is not ready.');
  res.json({ status: 'ready', service: process.env.SERVICE_NAME });
}));

const signupSchema = z.object({
  fullName: safeText(120),
  phone: phoneSchema.optional(),
  email: emailSchema,
  password: z.string().min(10).max(128)
});
app.post('/api/v1/auth/signup', authLimiter, asyncRoute(async (req, res) => {
  const input = signupSchema.parse(req.body);
  const { data, error } = await authClient.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { full_name: input.fullName, phone: input.phone || null } }
  });
  if (error) {
    const status = /already registered|already exists/i.test(error.message) ? 409 : 400;
    throw new HttpError(status, status === 409 ? 'ACCOUNT_EXISTS' : 'SIGNUP_FAILED', status === 409 ? 'An account with this email may already exist.' : 'We could not create this account. Check the details or try again.');
  }
  res.status(201).json({ data: { user: data.user ? { id: data.user.id, email: data.user.email } : null, session: data.session ? { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at } : null, emailConfirmationRequired: !data.session } });
}));

app.post('/api/v1/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).parse(req.body);
  const { data, error } = await authClient.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error || !data?.session || !data.user) throw new HttpError(401, 'LOGIN_FAILED', 'Email or password is incorrect, or the account needs email verification.');
  res.json({ data: { user: { id: data.user.id, email: data.user.email }, session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at } } });
}));

app.post('/api/v1/auth/refresh', authLimiter, asyncRoute(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20).max(4096) }).parse(req.body);
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session || !data.user) throw new HttpError(401, 'REFRESH_FAILED', 'Your session expired. Please sign in again.');
  res.json({ data: { user: { id: data.user.id, email: data.user.email }, session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at } } });
}));

app.post('/api/v1/auth/logout', auth, asyncRoute(async (req, res) => {
  // Revoke the current Supabase session where supported; the browser must also erase its local tokens.
  try { await accountsAdmin.auth.admin.signOut(req.accessToken, 'local'); } catch { /* token removal on the client remains mandatory */ }
  res.status(204).end();
}));

app.get('/api/v1/me', auth, asyncRoute(async (req, res) => {
  const { data, error } = await accountsAdmin.from('profiles').select('user_id,full_name,phone,created_at,updated_at').eq('user_id', req.user.id).maybeSingle();
  if (error) throw new HttpError(503, 'PROFILE_UNAVAILABLE', 'Your profile could not be loaded.');
  if (!data) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Your profile is not ready yet. Please try again shortly.');
  res.json({ data: { ...data, email: req.user.email } });
}));

app.patch('/api/v1/me/profile', auth, asyncRoute(async (req, res) => {
  const input = z.object({ fullName: optionalText(120), phone: phoneSchema.nullable().optional() }).refine(v => v.fullName !== undefined || v.phone !== undefined, 'Provide at least one field.').parse(req.body);
  const patch = { user_id: req.user.id, updated_at: new Date().toISOString() };
  if (input.fullName !== undefined) patch.full_name = input.fullName;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  const { data, error } = await accountsAdmin.from('profiles').upsert(patch, { onConflict: 'user_id' }).select('user_id,full_name,phone,created_at,updated_at').single();
  if (error) throw new HttpError(400, 'PROFILE_UPDATE_FAILED', 'We could not update your profile.');
  res.json({ data });
}));

const addressSchema = z.object({
  recipientName: safeText(120), phone: phoneSchema,
  addressLine1: safeText(240), addressLine2: optionalText(240), city: safeText(100),
  state: safeText(100), postalCode: optionalText(20), country: z.string().trim().length(2).default('NG'),
  landmark: optionalText(200), isDefault: z.boolean().default(false)
});
function addressRow(input, userId) {
  return {
    user_id: userId, recipient_name: input.recipientName, phone: input.phone,
    address_line1: input.addressLine1, address_line2: input.addressLine2 || null,
    city: input.city, state: input.state, postal_code: input.postalCode || null,
    country: input.country.toUpperCase(), landmark: input.landmark || null, is_default: input.isDefault
  };
}
async function unsetDefault(userId) {
  const { error } = await accountsAdmin.from('addresses').update({ is_default: false }).eq('user_id', userId).eq('is_default', true);
  if (error) throw new HttpError(503, 'ADDRESS_UPDATE_FAILED', 'We could not update your saved addresses.');
}
app.get('/api/v1/me/addresses', auth, asyncRoute(async (req, res) => {
  const { data, error } = await accountsAdmin.from('addresses').select('id,recipient_name,phone,address_line1,address_line2,city,state,postal_code,country,landmark,is_default,created_at,updated_at').eq('user_id', req.user.id).order('is_default', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw new HttpError(503, 'ADDRESSES_UNAVAILABLE', 'Your saved addresses could not be loaded.');
  res.json({ data: data || [] });
}));
app.post('/api/v1/me/addresses', auth, asyncRoute(async (req, res) => {
  const input = addressSchema.parse(req.body);
  if (input.isDefault) await unsetDefault(req.user.id);
  const { data, error } = await accountsAdmin.from('addresses').insert(addressRow(input, req.user.id)).select('id,recipient_name,phone,address_line1,address_line2,city,state,postal_code,country,landmark,is_default,created_at,updated_at').single();
  if (error) throw new HttpError(400, 'ADDRESS_CREATE_FAILED', 'We could not save this address.');
  res.status(201).json({ data });
}));
app.patch('/api/v1/me/addresses/:id', auth, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = addressSchema.partial().refine(v => Object.keys(v).length > 0, 'Provide at least one field.').parse(req.body);
  if (input.isDefault === true) await unsetDefault(req.user.id);
  const source = addressRow({
    recipientName: input.recipientName, phone: input.phone, addressLine1: input.addressLine1,
    addressLine2: input.addressLine2, city: input.city, state: input.state,
    postalCode: input.postalCode, country: input.country || 'NG', landmark: input.landmark,
    isDefault: input.isDefault ?? false
  }, req.user.id);
  const mapping = { recipientName: 'recipient_name', addressLine1: 'address_line1', addressLine2: 'address_line2', postalCode: 'postal_code', isDefault: 'is_default' };
  const patch = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) patch[mapping[key] || key] = key === 'country' ? value.toUpperCase() : (value === '' ? null : value);
  // Explicit patch map avoids accidentally accepting user_id or other protected columns.
  const allowed = ['recipient_name','phone','address_line1','address_line2','city','state','postal_code','country','landmark','is_default','updated_at'];
  for (const key of Object.keys(patch)) if (!allowed.includes(key)) delete patch[key];
  const { data, error } = await accountsAdmin.from('addresses').update(patch).eq('id', id).eq('user_id', req.user.id).select('id,recipient_name,phone,address_line1,address_line2,city,state,postal_code,country,landmark,is_default,created_at,updated_at').maybeSingle();
  if (error) throw new HttpError(400, 'ADDRESS_UPDATE_FAILED', 'We could not update this address.');
  if (!data) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'That address was not found.');
  res.json({ data });
}));
app.delete('/api/v1/me/addresses/:id', auth, asyncRoute(async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const { data, error } = await accountsAdmin.from('addresses').delete().eq('id', id).eq('user_id', req.user.id).select('id').maybeSingle();
  if (error) throw new HttpError(400, 'ADDRESS_DELETE_FAILED', 'We could not delete this address.');
  if (!data) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'That address was not found.');
  res.status(204).end();
}));

registerOwnerAdmin(app, { accountsAdmin, auth });

finishApp(app);
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', service: process.env.SERVICE_NAME, port })));
