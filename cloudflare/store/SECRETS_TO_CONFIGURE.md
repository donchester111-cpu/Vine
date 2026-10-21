# Private Worker settings

These are variable names only. Set the values in the matching Cloudflare Worker dashboard under **Settings → Variables and Secrets**. Keep values out of Wrangler files, frontend files, and GitHub.

- `AUTH_SUPABASE_ANON_KEY`
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY`
- `VINE_OWNER_USER_ID`
- `OWNER_SESSION_SECRET`
- `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY`
- `ORDERS_SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`

Retain the already-configured `ALLOWED_ORIGINS` value in Cloudflare. Do not replace it with a placeholder or an invented value. The Store Worker reads `CHECKOUT_ENABLED` from its Cloudflare dashboard setting; it is deliberately not hard-coded in `wrangler.jsonc`. The existing Supabase owner setting (`commerce.checkoutEnabled`) and payment-method settings remain additional runtime gates. Verify provider secrets and webhooks before taking real orders.
