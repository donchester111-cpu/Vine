import crypto from 'node:crypto';
import { escapeVineHtml } from '@vine/shared/email';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(env = process.env) {
  const base = String(env.RENDER_EXTERNAL_URL || 'https://vine-fnoh.onrender.com').trim().replace(/\/+$/, '');
  const uri = String(env.GOOGLE_OAUTH_REDIRECT_URI || `${base}/api/v1/email/google/callback`).trim();
  const parsed = new URL(uri);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS.');
  return uri;
}

function page(title, message, body = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeVineHtml(title)} | Vine</title><style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#f4f8f3;color:#123629;margin:0;padding:24px}.card{max-width:720px;margin:7vh auto;background:white;border:1px solid #dfe9e0;border-radius:18px;padding:28px;box-shadow:0 12px 36px #092d1b12}h1{font-size:24px;line-height:1.2}p{overflow-wrap:anywhere}textarea{box-sizing:border-box;width:100%;height:116px;padding:12px;border:1px solid #b7cdbb;border-radius:8px;font:12px ui-monospace,monospace}button{border:0;background:#087f45;color:white;border-radius:9px;padding:12px 16px;font-weight:700;margin:8px 0;cursor:pointer}.notice{background:#fff8df;padding:12px;border-radius:8px}</style></head><body><main class="card"><h1>${escapeVineHtml(title)}</h1><p>${escapeVineHtml(message)}</p>${body}<p style="color:#718078;font-size:12px">This page never asks for your Google password. Keep any refresh token private.</p></main></body></html>`;
}

function safePage(res, status, title, message, body = '') {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return res.status(status).type('html').send(page(title, message, body));
}

async function fetchGoogle(url, options = {}) {
  try { return await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) }); }
  catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new Error(timedOut ? 'Google took too long to respond. Please start the connection again.' : 'Vine could not reach Google. Check your connection and try again.');
  }
}

export function registerGoogleMailOAuthRoutes(app) {
  app.get('/api/v1/email/google/connect', async (req, res) => {
    try {
      const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
      const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
      const sender = String(process.env.GMAIL_SENDER_EMAIL || '').trim().toLowerCase();
      if (!clientId || !clientSecret || !/^\S+@\S+\.\S+$/.test(sender)) {
        return safePage(res, 503, 'Gmail connection not configured', 'First add GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GMAIL_SENDER_EMAIL to the Vine Accounts API environment in Render.');
      }
      const state = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      for (const [key, expiresAt] of pendingStates) if (expiresAt <= now) pendingStates.delete(key);
      pendingStates.set(state, now + STATE_TTL_MS);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: `openid email ${GOOGLE_GMAIL_SEND_SCOPE}`,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        login_hint: sender,
        state
      });
      return res.redirect(302, `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
    } catch (error) {
      return safePage(res, 500, 'Could not start Gmail connection', error?.message || 'Check the Google OAuth configuration in Render.');
    }
  });

  app.get('/api/v1/email/google/callback', async (req, res) => {
    const state = String(req.query.state || '');
    const expiry = pendingStates.get(state);
    if (!state || !expiry || expiry < Date.now()) {
      pendingStates.delete(state);
      return safePage(res, 400, 'Gmail connection expired', 'This Google authorisation request is missing, expired, or already used. Open the Vine Gmail connection link again and retry.');
    }
    pendingStates.delete(state); // one-time state prevents replay of the callback
    if (req.query.error) {
      return safePage(res, 400, 'Gmail connection was cancelled', 'Google did not grant Gmail access. Return to Vine and restart the connection if you still want to enable email delivery.');
    }
    const code = String(req.query.code || '');
    if (!code || code.length > 4096) return safePage(res, 400, 'Google did not return an authorisation code', 'Restart the Google connection from Vine.');

    try {
      const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
      const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
      const expectedSender = String(process.env.GMAIL_SENDER_EMAIL || '').trim().toLowerCase();
      if (!clientId || !clientSecret || !expectedSender) return safePage(res, 503, 'Gmail connection is not configured', 'Add the Google OAuth client details and sender email to Render, then restart the connection.');
      const uri = redirectUri();
      const tokenResponse = await fetchGoogle(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: uri, grant_type: 'authorization_code' })
      });
      let tokens = null;
      try { tokens = await tokenResponse.json(); } catch { /* handled below */ }
      if (!tokenResponse.ok || !tokens?.access_token) {
        console.warn(JSON.stringify({ level: 'warn', service: 'vine-accounts-api', event: 'gmail_oauth_token_exchange_failed', status: tokenResponse.status, code: String(tokens?.error || 'TOKEN_EXCHANGE_FAILED').slice(0, 80) }));
        return safePage(res, 502, 'Google could not finish the connection', 'Check that the client ID, client secret, and redirect URI in Render exactly match the OAuth client in Google Cloud, then try again.');
      }
      const profileResponse = await fetchGoogle(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      let profile = null;
      try { profile = await profileResponse.json(); } catch { /* handled below */ }
      if (!profileResponse.ok || !profile?.email || profile.email_verified !== true) {
        return safePage(res, 502, 'Google could not verify the sender account', 'Grant the requested email identity permission and restart the connection.');
      }
      if (String(profile.email).trim().toLowerCase() !== expectedSender) {
        return safePage(res, 403, 'Wrong Google account', `This connection must use ${expectedSender}. Google returned a different account, so Vine did not keep its token. Sign in to the correct Gmail account and try again.`);
      }
      if (!tokens.refresh_token) {
        return safePage(res, 409, 'Google did not issue a refresh token', 'Remove the Vine Email Service app from your Google Account security connections, then open the Vine connection link again. Google must grant offline access for automatic sending.');
      }
      const tokenValue = escapeVineHtml(tokens.refresh_token);
      const body = `<p>Google verified <strong>${escapeVineHtml(expectedSender)}</strong>. Copy the token below and save it as <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> in Render for the Accounts API and Operations API. The token is shown only on this page; do not paste it into chat or GitHub.</p><textarea id="refreshToken" readonly>${tokenValue}</textarea><p><button type="button" id="copyToken">Copy refresh token</button> <span id="copyStatus" aria-live="polite"></span></p><script>document.getElementById('copyToken').addEventListener('click',async()=>{const field=document.getElementById('refreshToken');try{await navigator.clipboard.writeText(field.value);document.getElementById('copyStatus').textContent='Copied. Paste it into Render now.'}catch{field.focus();field.select();document.getElementById('copyStatus').textContent='Select and copy the token manually.'}})</script><p class="notice">After adding the variable in Render, remove it from clipboard history if your device offers that option. Never share the token.</p>`;
      return safePage(res, 200, 'Gmail connected successfully', 'Vine is authorised to send email through the intended Gmail account. One final Render environment variable is needed to persist the connection.', body);
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', service: 'vine-accounts-api', event: 'gmail_oauth_callback_failed', message: String(error?.message || 'OAUTH_CALLBACK_FAILED').slice(0, 120) }));
      return safePage(res, 502, 'Gmail connection failed', error?.message || 'Try starting the Google connection again.');
    }
  });
}
