# Operations Worker: Variables and Secrets

Set these in Cloudflare Dashboard → Workers & Pages → `operations-api` → Settings → Variables and Secrets. Do not share or place service-role keys, payment secrets, or OAuth refresh tokens in browser code, Wrangler config, GitHub, or this ZIP.

## Required for Operations API startup

- `AUTH_SUPABASE_URL` — `https://jktuwbgocpixtelfxzwq.supabase.co`
- `AUTH_SUPABASE_ANON_KEY` — public/publishable Auth-project key
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Auth/Accounts Supabase project
- `PRODUCTS_SUPABASE_URL` — `https://xiehbdaaioifjcbnvpqf.supabase.co`
- `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Products Supabase project
- `ORDERS_SUPABASE_URL` — `https://ybwdecxsbveiobfvwkvr.supabase.co`
- `ORDERS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Orders/Payments Supabase project
- `OPERATIONS_SUPABASE_URL` — `https://sqtntfnbjtguqddvvsly.supabase.co`
- `OPERATIONS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Operations Supabase project

## Required for Vineowner-managed endpoints

Use the same `OWNER_SESSION_SECRET`, `VINE_OWNER_EMAIL`, and `VINE_OWNER_USER_ID` as the Accounts Worker. `OWNER_SESSION_SECRET` must be at least 32 characters. Add `ALLOWED_ORIGINS` if frontends run on origins other than the two canonical Vine domains.

## Optional integrations

- Paystack: `PAYSTACK_SECRET_KEY`; `PAYSTACK_CALLBACK_URL` if a custom callback URL is required.
- Bank-transfer instructions: `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_ACCOUNT_NAME`, `BANK_TRANSFER_ACCOUNT_NUMBER`.
- Resend email: `RESEND_API_KEY` and `VINE_EMAIL_FROM`; or Gmail API: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and `GMAIL_SENDER_EMAIL`.
- `SMS_PROVIDER` only if an SMS provider is actually configured.
- `CHECKOUT_ENABLED` should stay `false` until live end-to-end payment, order creation, webhook verification, and delivery creation are tested.

Optional provider settings must not prevent `/health` or database readiness checks from starting. The Operations Worker cron trigger (`*/5 * * * *`) should remain configured. Test `https://operations-api.donchester111.workers.dev/health` and `/ready`; the ready route checks the connected data stores.
