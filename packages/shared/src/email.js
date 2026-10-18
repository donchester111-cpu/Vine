import { HttpError } from './errors.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function isVineEmailConfigured(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.VINE_EMAIL_FROM || '').trim();
  return Boolean(apiKey && /^.{1,120}<[^<>\s]+@[^<>\s]+>$|^[^<>\s]+@[^<>\s]+$/.test(from) && !/[\r\n]/.test(from));
}

export function assertVineEmailConfigured(env = process.env) {
  if (!isVineEmailConfigured(env)) {
    throw new HttpError(503, 'EMAIL_PROVIDER_NOT_CONFIGURED', 'Vine transactional email is not configured. Add a Resend API key and a verified Vine sender address to this service before sending staff links or customer updates.');
  }
}

export function escapeVineHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export async function sendVineEmail({ to, subject, text, html, idempotencyKey }, env = process.env) {
  assertVineEmailConfigured(env);
  const recipient = String(to || '').trim();
  const safeSubject = String(subject || '').trim();
  const plainText = String(text || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(recipient) || /[\r\n]/.test(recipient)) {
    throw new HttpError(400, 'EMAIL_RECIPIENT_INVALID', 'The message recipient is not a valid email address.');
  }
  if (!safeSubject || safeSubject.length > 160 || /[\r\n]/.test(safeSubject) || !plainText) {
    throw new HttpError(400, 'EMAIL_MESSAGE_INVALID', 'The email message is incomplete.');
  }

  const headers = {
    Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey && /^[A-Za-z0-9._:-]{8,200}$/.test(String(idempotencyKey))) {
    headers['Idempotency-Key'] = String(idempotencyKey);
  }

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: String(env.VINE_EMAIL_FROM).trim(),
        to: [recipient],
        subject: safeSubject,
        text: plainText,
        ...(html ? { html: String(html) } : {})
      }),
      signal: AbortSignal.timeout(12_000)
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_UNAVAILABLE';
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider: 'resend', code }));
    throw new HttpError(502, code, code === 'EMAIL_PROVIDER_TIMEOUT'
      ? 'The email provider took too long to respond. Please try again shortly.'
      : 'Vine could not reach the email provider. Please try again shortly.');
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* Some provider errors may not include JSON. */ }
  if (!response.ok) {
    const providerCode = String(payload?.name || payload?.code || 'PROVIDER_REJECTED').slice(0, 80);
    console.warn(JSON.stringify({ level: 'warn', service: process.env.SERVICE_NAME || 'vine', provider: 'resend', status: response.status, code: providerCode }));
    if (response.status === 429) {
      throw new HttpError(429, 'EMAIL_PROVIDER_RATE_LIMITED', 'The email provider has temporarily limited messages. Wait before retrying.');
    }
    if (response.status >= 500) {
      throw new HttpError(502, 'EMAIL_PROVIDER_UNAVAILABLE', 'The email provider is temporarily unavailable. Please try again shortly.');
    }
    throw new HttpError(502, 'EMAIL_PROVIDER_REJECTED', 'The email provider rejected this message. Check that Vine’s sender domain is verified and the recipient address is allowed.');
  }

  if (!payload?.id) {
    throw new HttpError(502, 'EMAIL_PROVIDER_RESPONSE_INVALID', 'The email provider accepted no verifiable message ID. Check the provider dashboard before retrying.');
  }
  return { id: String(payload.id) };
}
