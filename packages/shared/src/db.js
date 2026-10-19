import { createClient } from '@supabase/supabase-js';

const authOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { headers: { 'X-Client-Info': 'vine-backend/0.1.0' } }
};

export function createSupabaseClient(url, key, label = 'Supabase') {
  if (!url || !key) throw new Error(`${label} configuration is missing. Set the required environment variables.`);
  return createClient(url, key, authOptions);
}

export function createAuthContext(env = process.env) {
  const authUrl = env.AUTH_SUPABASE_URL;
  const authAnonKey = env.AUTH_SUPABASE_ANON_KEY;
  const accountsServiceKey = env.ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY;
  if (!authUrl || !authAnonKey) throw new Error('AUTH_SUPABASE_URL and AUTH_SUPABASE_ANON_KEY are required.');
  const authClient = createSupabaseClient(authUrl, authAnonKey, 'Supabase Auth');
  const accountsAdmin = accountsServiceKey
    ? createSupabaseClient(authUrl, accountsServiceKey, 'Vine accounts database')
    : null;
  return { authClient, accountsAdmin };
}

export function getAllowedOrigins(value = process.env.ALLOWED_ORIGINS) {
  // The private owner console is hosted on this canonical origin. Keep it explicitly
  // allow-listed even if a Render ALLOWED_ORIGINS value is incomplete; environment
  // entries remain additive so staging and other approved frontends still work.
  const requiredOrigins = [
    'https://vinestore.com.ng',
    'https://www.vinestore.com.ng'
  ];
  const configuredOrigins = String(value || 'http://localhost:8080,http://127.0.0.1:5500')
    .split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...requiredOrigins, ...configuredOrigins])];
}
