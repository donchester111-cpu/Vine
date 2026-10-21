import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { applySecurity, createRateLimiter, finishApp, sendHealth } from '@vine/shared/app';
import { createAuthContext } from '@vine/shared/db';
import { createOwnerSessionToken, requireAuth } from '@vine/shared/auth';
import { asyncRoute, HttpError } from '@vine/shared/errors';
import { assertVineEmailConfigured, escapeVineHtml, sendVineEmail } from '@vine/shared/email';
import { emailSchema, optionalText, phoneSchema, safeText, uuidSchema } from '@vine/shared/validation';
import { registerOwnerAdmin } from './owner-admin.js';

process.env.SERVICE_NAME = 'vine-accounts-api';
const { authClient, accountsAdmin } = createAuthContext();
if (!accountsAdmin) throw new Error('ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY is required for vine-accounts-api.');
const app = express();
app.set('trust proxy', 1);
applySecurity(app, { requestLimit: 120 });
app.use(express.json({ limit: '1mb' }));
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
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

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/v1/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).parse(req.body);
  const ownerEmail = String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
  const submittedEmail = input.email.trim().toLowerCase();

    // Owner login is entirely server-authenticated. It never calls Supabase Auth sign-in,
    // magic-link generation, OTP verification, or token refresh.
    if (submittedEmail === ownerEmail) {
      const ownerPassword = process.env.OWNER_PASSWORD;
      const ownerUserId = String(process.env.VINE_OWNER_USER_ID || '').trim();
      if (!ownerPassword) {
        throw new HttpError(503, 'OWNER_LOGIN_NOT_CONFIGURED', 'Owner sign-in is not configured on the server.');
      }
      if (!ownerUserId) {
        throw new HttpError(503, 'OWNER_ID_NOT_CONFIGURED', 'The owner identity is not configured on the server.');
      }
      if (!timingSafeStringEqual(input.password, ownerPassword)) {
        throw new HttpError(401, 'LOGIN_FAILED', 'Owner email or password is incorrect.');
      }
      const localSession = createOwnerSessionToken({ id: ownerUserId, email: ownerEmail });
      res.json({ data: {
        user: { id: ownerUserId, email: ownerEmail },
        session: { accessToken: localSession.accessToken, refreshToken: null, expiresAt: localSession.expiresAt, tokenType: 'Bearer', authType: 'server-owner' }
      } });
      return;
    }

  // Regular customer login remains ordinary Supabase email/password authentication.
  const { data, error } = await authClient.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error || !data?.session || !data.user) throw new HttpError(401, 'LOGIN_FAILED', 'Email or password is incorrect, or the account needs email verification.');
  res.json({ data: { user: { id: data.user.id, email: data.user.email }, session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at } } });
}));

async function findAuthUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const pageSize = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await accountsAdmin.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) {
      console.error(JSON.stringify({ level: 'error', event: 'staff_auth_directory_lookup_failed', code: error.code || 'AUTH_DIRECTORY_ERROR' }));
      throw new HttpError(503, 'STAFF_DIRECTORY_UNAVAILABLE', 'Vine could not verify the staff directory right now. Please try again shortly.');
    }
    const users = data?.users || [];
    const found = users.find(user => String(user.email || '').trim().toLowerCase() === normalized);
    if (found) return found;
    if (users.length < pageSize) return null;
  }
  throw new HttpError(503, 'STAFF_DIRECTORY_UNAVAILABLE', 'Vine could not verify the staff directory right now. Please try again shortly.');
}

async function hasActiveStaffAssignment(user) {
  const { data: membership, error: membershipError } = await accountsAdmin
    .from('staff_memberships')
    .select('user_id,role_id,status,staff_roles(name,is_owner_role)')
    .eq('user_id', user.id)
    .maybeSingle();
  if (membershipError) throw new HttpError(503, 'STAFF_ACCESS_UNAVAILABLE', 'Staff permissions could not be checked. Please try again shortly.');
  if (membership) {
    if (membership.status !== 'active') return false;
    const roleData = Array.isArray(membership.staff_roles) ? membership.staff_roles[0] : membership.staff_roles;
    if (roleData?.is_owner_role) {
      return String(user.email || '').trim().toLowerCase() === String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
    }
    const { data: grants, error: grantsError } = await accountsAdmin.from('staff_role_permissions').select('permission_id').eq('role_id', membership.role_id).limit(1);
    if (grantsError) throw new HttpError(503, 'STAFF_ACCESS_UNAVAILABLE', 'Staff permissions could not be checked. Please try again shortly.');
    const { data: overrides, error: overridesError } = await accountsAdmin.from('staff_user_permissions').select('permission_id,effect').eq('user_id', user.id).eq('effect', 'allow').limit(1);
    if (overridesError) throw new HttpError(503, 'STAFF_ACCESS_UNAVAILABLE', 'Staff permissions could not be checked. Please try again shortly.');
    return Boolean(grants?.length || overrides?.length);
  }

  // Compatibility for staff entries created before the configurable membership tables.
  const { data: legacyRoles, error: legacyError } = await accountsAdmin.from('admin_roles').select('role').eq('user_id', user.id);
  if (legacyError) throw new HttpError(503, 'STAFF_ACCESS_UNAVAILABLE', 'Staff permissions could not be checked. Please try again shortly.');
  const email = String(user.email || '').trim().toLowerCase();
  const ownerEmail = String(process.env.VINE_OWNER_EMAIL || 'donchester111@gmail.com').trim().toLowerCase();
  return (legacyRoles || []).some(row => {
    const role = String(row.role || '').toLowerCase();
    return ['admin', 'catalog', 'operations', 'support'].includes(role) || (role === 'owner' && email === ownerEmail);
  });
}

// Staff magic links are generated by Supabase but delivered through Vine's configured
// transactional provider, avoiding Supabase's built-in two-emails-per-hour sender cap.
// Only a pre-existing, active staff account receives a link; this endpoint never creates users.
app.post('/api/v1/staff/auth/request-link', authLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ email: emailSchema }).parse(req.body);
  assertVineEmailConfigured();
  const email = input.email.trim().toLowerCase();
  const user = await findAuthUserByEmail(email);
  if (!user || !(await hasActiveStaffAssignment(user))) {
    // Do not reveal whether an email belongs to an account or staff membership.
    return res.status(202).json({ data: { accepted: true, message: 'If this email belongs to an active Vine staff account, a secure sign-in link will be sent.' } });
  }

  const redirectTo = String(process.env.VINE_STAFF_INVITE_REDIRECT_URL || 'https://vinestore.com.ng/vineger.html').trim();
  const { data, error } = await accountsAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo }
  });
  const actionLink = data?.properties?.action_link;
  if (error || !actionLink) {
    const code = error?.code || error?.name || 'AUTH_LINK_GENERATION_FAILED';
    console.warn(JSON.stringify({ level: 'warn', event: 'staff_magic_link_generation_failed', code }));
    throw new HttpError(503, 'STAFF_LINK_GENERATION_FAILED', 'Vine could not prepare your secure sign-in link. Please try again shortly.');
  }

  await sendVineEmail({
    to: email,
    subject: 'Your secure Vineger sign-in link',
    text: `Use this one-time link to sign in to Vineger: ${actionLink}

If you did not request this link, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#173b28;max-width:560px;margin:0 auto"><h2 style="color:#087f45">Sign in to Vineger</h2><p>Use this one-time link to securely access the Vine staff workspace.</p><p><a href="${escapeVineHtml(actionLink)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#087f45;color:#fff;text-decoration:none;font-weight:700">Sign in to Vineger</a></p><p style="font-size:12px;color:#64756a">If you did not request this link, you can ignore this email. This link is for your account only.</p></div>`,
    idempotencyKey: `vineger-login:${user.id}:${data.properties?.email_otp || data.properties?.hashed_token || Date.now()}`
  });

  res.status(202).json({ data: { accepted: true, message: 'Your secure sign-in link has been sent. Check your inbox and spam folder.' } });
}));

app.post('/api/v1/auth/refresh', authLimiter, asyncRoute(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20).max(4096) }).parse(req.body);
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session || !data.user) throw new HttpError(401, 'REFRESH_FAILED', 'Your session expired. Please sign in again.');
  res.json({ data: { user: { id: data.user.id, email: data.user.email }, session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at } } });
}));

app.post('/api/v1/auth/logout', auth, asyncRoute(async (req, res) => {
  // Supabase customer sessions may be revoked server-side. Owner sessions are stateless and expire after two hours; the owner page discards its in-memory token on sign-out.
  if (req.authType !== 'owner-server') {
    try { await accountsAdmin.auth.admin.signOut(req.accessToken, 'local'); } catch { /* client token removal remains mandatory */ }
  }
  res.status(204).end();
}));

const profilePhotoBucket = 'vine-profile-photos';
const profilePhotoLimitBytes = 512 * 1024;
const profilePhotoTypes = new Map([
  ['image/jpeg', { extension: 'jpg', matches: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: 'png', matches: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) }],
  ['image/webp', { extension: 'webp', matches: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }]
]);
function profilePhotoObjectPath(url, userId) {
  try {
    const parsed = new URL(String(url || ''));
    const marker = `/storage/v1/object/public/${profilePhotoBucket}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;
    const path = decodeURIComponent(parsed.pathname.slice(index + marker.length));
    return path.startsWith(`${userId}/`) ? path : null;
  } catch { return null; }
}

app.get('/api/v1/me', auth, asyncRoute(async (req, res) => {
  const { data, error } = await accountsAdmin.from('profiles').select('user_id,full_name,phone,avatar_url,created_at,updated_at').eq('user_id', req.user.id).maybeSingle();
  if (error) throw new HttpError(503, 'PROFILE_UNAVAILABLE', 'Your profile could not be loaded.');
  if (!data) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Your profile is not ready yet. Please try again shortly.');
  res.json({ data: { ...data, email: req.user.email } });
}));

app.patch('/api/v1/me/profile', auth, asyncRoute(async (req, res) => {
  const input = z.object({ fullName: optionalText(120), phone: phoneSchema.nullable().optional() }).refine(v => v.fullName !== undefined || v.phone !== undefined, 'Provide at least one field.').parse(req.body);
  const patch = { user_id: req.user.id, updated_at: new Date().toISOString() };
  if (input.fullName !== undefined) patch.full_name = input.fullName;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  const { data, error } = await accountsAdmin.from('profiles').upsert(patch, { onConflict: 'user_id' }).select('user_id,full_name,phone,avatar_url,created_at,updated_at').single();
  if (error) throw new HttpError(400, 'PROFILE_UPDATE_FAILED', 'We could not update your profile.');
  res.json({ data });
}));

app.post('/api/v1/me/profile-avatar', auth, asyncRoute(async (req, res) => {
  const input = z.object({ mimeType: z.enum(['image/jpeg','image/png','image/webp']), dataBase64: z.string().min(1).max(700000) }).parse(req.body);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64) || input.dataBase64.length % 4 === 1) {
    throw new HttpError(400, 'INVALID_PROFILE_PHOTO', 'Choose a valid JPG, PNG or WebP image.');
  }
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (!bytes.length || bytes.length > profilePhotoLimitBytes || !profilePhotoTypes.get(input.mimeType).matches(bytes)) {
    throw new HttpError(400, 'INVALID_PROFILE_PHOTO', 'The photo must be a valid JPG, PNG or WebP image no larger than 512 KB after compression.');
  }
  const { data: oldProfile, error: oldProfileError } = await accountsAdmin.from('profiles').select('avatar_url').eq('user_id', req.user.id).maybeSingle();
  if (oldProfileError) throw new HttpError(503, 'PROFILE_UNAVAILABLE', 'Your profile could not be loaded before saving the photo.');
  const kind = profilePhotoTypes.get(input.mimeType);
  const objectPath = `${req.user.id}/${crypto.randomUUID()}.${kind.extension}`;
  const { error: uploadError } = await accountsAdmin.storage.from(profilePhotoBucket).upload(objectPath, bytes, {
    contentType: input.mimeType, cacheControl: '0', upsert: false
  });
  if (uploadError) {
    console.error(JSON.stringify({ level: 'error', event: 'profile_photo_upload_failed', code: uploadError.code || 'STORAGE_ERROR' }));
    throw new HttpError(503, 'PROFILE_PHOTO_UPLOAD_FAILED', 'Vine could not save your profile picture. Please try again shortly.');
  }
  const avatarUrl = accountsAdmin.storage.from(profilePhotoBucket).getPublicUrl(objectPath).data.publicUrl;
  const { data, error: profileUpdateError } = await accountsAdmin.from('profiles').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('user_id', req.user.id).select('user_id,full_name,phone,avatar_url,created_at,updated_at').maybeSingle();
  if (profileUpdateError || !data) {
    await accountsAdmin.storage.from(profilePhotoBucket).remove([objectPath]).catch(() => {});
    throw new HttpError(503, 'PROFILE_PHOTO_SAVE_FAILED', 'The photo uploaded but Vine could not save it to your profile. Please try again.');
  }
  const previousPath = profilePhotoObjectPath(oldProfile?.avatar_url, req.user.id);
  if (previousPath && previousPath !== objectPath) {
    const { error: removeError } = await accountsAdmin.storage.from(profilePhotoBucket).remove([previousPath]);
    if (removeError) console.warn(JSON.stringify({ level: 'warn', event: 'old_profile_photo_cleanup_failed', code: removeError.code || 'STORAGE_ERROR' }));
  }
  res.status(201).json({ data: { ...data, email: req.user.email } });
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
