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
  return String(value || 'http://localhost:8080,http://127.0.0.1:5500')
    .split(',').map(s => s.trim()).filter(Boolean);
}
