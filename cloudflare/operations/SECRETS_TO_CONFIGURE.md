# Private Worker settings

These are variable names only. Set the values in the matching Cloudflare Worker dashboard under **Settings → Variables and Secrets**. Keep values out of Wrangler files, frontend files, and GitHub.

- `AUTH_SUPABASE_ANON_KEY`
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY`
- `VINE_OWNER_USER_ID`
- `OWNER_SESSION_SECRET`
- `RESEND_API_KEY`
- `VINE_EMAIL_FROM`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY`
- `ORDERS_SUPABASE_SERVICE_ROLE_KEY`
- `OPERATIONS_SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_CALLBACK_URL`
- `BANK_TRANSFER_BANK_NAME`
- `BANK_TRANSFER_ACCOUNT_NAME`
- `BANK_TRANSFER_ACCOUNT_NUMBER`

Retain the already-configured `ALLOWED_ORIGINS` value in Cloudflare. Do not replace it with a placeholder or an invented value. The Store Worker reads `CHECKOUT_ENABLED` from its Cloudflare dashboard setting; it is deliberately not hard-coded in `wrangler.jsonc`. The existing Supabase owner setting (`commerce.checkoutEnabled`) and payment-method settings remain additional runtime gates. Verify provider secrets and webhooks before taking real orders.
