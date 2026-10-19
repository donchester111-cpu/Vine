import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export function isResendEmailConfigured(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.VINE_EMAIL_FROM || '').trim();
  return Boolean(apiKey && /^.{1,120}<[^<>\s]+@[^<>\s]+>$|^[^<>\s]+@[^<>\s]+$/.test(from) && !/[\r\n]/.test(from));
}

export function isGoogleGmailConfigured(env = process.env) {
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim();
  const sender = String(env.GMAIL_SENDER_EMAIL || '').trim().toLowerCase();
  return Boolean(clientId && clientSecret && refreshToken && EMAIL_RE.test(sender) && !/[\r\n]/.test(sender));
}

export function getVineEmailProvider(env = process.env) {
  if (isResendEmailConfigured(env)) return 'resend';
  if (isGoogleGmailConfigured(env)) return 'google-gmail';
  return null;
}

export function isVineEmailConfigured(env = process.env) {
  return getVineEmailProvider(env) !== null;
}

export function assertVineEmailConfigured(env = process.env) {
  if (!isVineEmailConfigured(env)) {
    throw new HttpError(503, 'EMAIL_PROVIDER_NOT_CONFIGURED', 'Vine email delivery is not configured yet. Connect the Vine Gmail account or configure a verified Resend sender before sending staff sign-in links.');
  }
}

export function escapeVineHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function validateMessage({ to, subject, text }) {
  const recipient = String(to || '').trim();
  const safeSubject = String(subject || '').trim();
  const plainText = String(text || '').trim();
  if (!EMAIL_RE.test(recipient) || /[\r\n]/.test(recipient)) {
    throw new HttpError(400, 'EMAIL_RECIPIENT_INVALID', 'The message recipient is not a valid email address.');
  }
  if (!safeSubject || safeSubject.length > 160 || /[\r\n]/.test(safeSubject) || !plainText) {
    throw new HttpError(400, 'EMAIL_MESSAGE_INVALID', 'The email message is incomplete.');
  }
  return { recipient, safeSubject, plainText };
}

function base64MimeBody(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

function makeGmailRawMessage({ sender, recipient, subject, text, html }) {
  const boundary = `vine-${cryptoRandomBoundary()}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: Vine <${sender}>`,
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64MimeBody(text)
  ];
  if (html) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64MimeBody(html)
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function cryptoRandomBoundary() {
  // A MIME boundary needs uniqueness, not secrecy; use Node's built-in cryptographic RNG.
  return crypto.randomBytes(18).toString('hex');
}

async function fetchWithTimeout(url, options, provider) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_UNAVAILABLE';
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider, code }));
    throw new HttpError(502, code, code === 'EMAIL_PROVIDER_TIMEOUT'
      ? 'The email provider took too long to respond. Please try again shortly.'
      : 'Vine could not reach the email provider. Please try again shortly.');
  }
}

async function sendViaResend({ recipient, subject, text, html, idempotencyKey }, env) {
  const headers = { Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, 'Content-Type': 'application/json' };
  if (idempotencyKey && /^[A-Za-z0-9._:-]{8,200}$/.test(String(idempotencyKey))) headers['Idempotency-Key'] = String(idempotencyKey);
  const response = await fetchWithTimeout(RESEND_ENDPOINT, {
    method: 'POST', headers,
    body: JSON.stringify({ from: String(env.VINE_EMAIL_FROM).trim(), to: [recipient], subject, text, ...(html ? { html: String(html) } : {}) })
  }, 'resend');
  let payload = null;
  try { payload = await response.json(); } catch { /* provider may return a non-JSON failure */ }
  if (!response.ok) {
    const providerCode = String(payload?.name || payload?.code || 'PROVIDER_REJECTED').slice(0, 80);
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider: 'resend', status: response.status, code: providerCode }));
    if (response.status === 429) throw new HttpError(429, 'EMAIL_PROVIDER_RATE_LIMITED', 'The email provider has temporarily limited messages. Wait before retrying.');
    if (response.status >= 500) throw new HttpError(502, 'EMAIL_PROVIDER_UNAVAILABLE', 'The email provider is temporarily unavailable. Please try again shortly.');
    throw new HttpError(502, 'EMAIL_PROVIDER_REJECTED', 'The email provider rejected this message. Check the sender configuration and recipient address.');
  }
  if (!payload?.id) throw new HttpError(502, 'EMAIL_PROVIDER_RESPONSE_INVALID', 'The email provider accepted no verifiable message ID. Check the provider dashboard before retrying.');
  return { id: String(payload.id), provider: 'resend' };
}

async function getGmailAccessToken(env) {
  const body = new URLSearchParams({
    client_id: String(env.GOOGLE_OAUTH_CLIENT_ID).trim(),
    client_secret: String(env.GOOGLE_OAUTH_CLIENT_SECRET).trim(),
    refresh_token: String(env.GOOGLE_OAUTH_REFRESH_TOKEN).trim(),
    grant_type: 'refresh_token'
  });
  const response = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  }, 'google-gmail');
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !payload?.access_token) {
    const providerCode = String(payload?.error || 'TOKEN_REFRESH_FAILED').slice(0, 80);
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider: 'google-gmail', status: response.status, code: providerCode }));
    throw new HttpError(503, 'GMAIL_REAUTH_REQUIRED', 'Vine could not refresh its Gmail authorisation. Reconnect the Google account and update GOOGLE_OAUTH_REFRESH_TOKEN in Render.');
  }
  return String(payload.access_token);
}

async function sendViaGmail({ recipient, subject, text, html }, env) {
  const sender = String(env.GMAIL_SENDER_EMAIL).trim().toLowerCase();
  const accessToken = await getGmailAccessToken(env);
  const raw = makeGmailRawMessage({ sender, recipient, subject, text, html: html ? String(html) : '' });
  const response = await fetchWithTimeout(GOOGLE_GMAIL_SEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  }, 'google-gmail');
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !payload?.id) {
    const providerCode = String(payload?.error?.status || payload?.error?.message || 'GMAIL_SEND_FAILED').slice(0, 80);
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider: 'google-gmail', status: response.status, code: providerCode }));
    if (response.status === 401 || response.status === 403) throw new HttpError(503, 'GMAIL_REAUTH_REQUIRED', 'Google rejected Vine’s Gmail permission. Reconnect the Google account and ensure the Gmail API remains enabled.');
    if (response.status === 429) throw new HttpError(429, 'EMAIL_PROVIDER_RATE_LIMITED', 'Google has temporarily limited email sending. Wait before retrying.');
    throw new HttpError(502, 'EMAIL_PROVIDER_REJECTED', 'Google Gmail could not send this message. Check the connected account and Gmail API status.');
  }
  return { id: String(payload.id), provider: 'google-gmail' };
}

export async function sendVineEmail({ to, subject, text, html, idempotencyKey }, env = process.env) {
  assertVineEmailConfigured(env);
  const { recipient, safeSubject, plainText } = validateMessage({ to, subject, text });
  if (getVineEmailProvider(env) === 'resend') {
    return sendViaResend({ recipient, subject: safeSubject, text: plainText, html, idempotencyKey }, env);
  }
  return sendViaGmail({ recipient, subject: safeSubject, text: plainText, html }, env);
}
