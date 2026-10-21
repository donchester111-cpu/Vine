# Vine Cloudflare recovery checklist

The provided production build logs show that Cloudflare uploaded all three Workers. Build success is not a runtime health check. The original Worker entry files also blocked *all* requests when optional email, OAuth, Paystack, SMS, or checkout variables were missing, even when those integrations were not being used. This revision changes startup blocking to database connection essentials only; integrations remain configured per feature. The Wrangler configs also set `keep_vars: true`, which prevents a config-based deploy from clearing ordinary dashboard variables that are not declared in the Wrangler file; Cloudflare secrets persist independently.

## 1. Apply this ZIP without writing to GitHub

Extract `Vine-main-cloudflare-runtime-fix.zip`. From the extracted `Vine-main` directory in a terminal with Node.js and Bun installed:

```bash
bun install
npx wrangler login
npx wrangler deploy --config cloudflare/accounts/wrangler.jsonc
npx wrangler deploy --config cloudflare/store/wrangler.jsonc
npx wrangler deploy --config cloudflare/operations/wrangler.jsonc
```

This deploys from the local extracted files; it does not push or write to GitHub. Existing Worker dashboard Variables and Secrets are separate from the ZIP and should be retained.

## 2. Confirm core variables are present on each Worker

- **accounts-api:** `AUTH_SUPABASE_URL`, `AUTH_SUPABASE_ANON_KEY`, `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY`.
- **store-api:** the three above plus `PRODUCTS_SUPABASE_URL`, `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY`, `ORDERS_SUPABASE_URL`, `ORDERS_SUPABASE_SERVICE_ROLE_KEY`.
- **operations-api:** Auth + Accounts, Products, Orders, and Operations URLs and service-role keys (see that Worker’s `SECRETS_TO_CONFIGURE.md`).

Use the existing Supabase projects already in Vine. Copy service-role keys directly from their respective Supabase Project Settings → API/Keys into Cloudflare Worker secrets. Never paste service-role keys into chat or browser HTML.

For owner login, Accounts must additionally have `OWNER_PASSWORD`, `OWNER_SESSION_SECRET` (32+ characters), `VINE_OWNER_EMAIL`, and `VINE_OWNER_USER_ID` configured correctly. Use the same owner session secret/email/UUID in all three API Workers. Keep provider credentials optional until a specific integration is being tested.

## 3. Check runtime, not build status

Open these URLs directly in a browser:

- `https://accounts-api.donchester111.workers.dev/health`
- `https://accounts-api.donchester111.workers.dev/ready`
- `https://store-api.donchester111.workers.dev/health`
- `https://store-api.donchester111.workers.dev/ready`
- `https://operations-api.donchester111.workers.dev/health`
- `https://operations-api.donchester111.workers.dev/ready`

Each `/health` should return JSON with `status: "ok"`. Each `/ready` should return `status: "ready"`. If it fails, open that Worker → Logs/Observability and read the runtime exception. Do not share the values of any secrets. Share only the error message and HTTP status.

If direct endpoints work but a page cannot call them, check `ALLOWED_ORIGINS` and that it contains the **exact origin** shown in the browser address bar (scheme and domain, no path or trailing slash). CORS errors often appear in the browser as a generic network failure.

## 4. Safe validation order

First verify all three `/health` and `/ready` endpoints; then test customer sign-in, Vineowner login, Vineger staff sign-in link delivery, product listing, product editing, paid-order delivery tracking, and only then controlled test checkout. Keep `CHECKOUT_ENABLED=false` until that final payment validation passes. Do not delete the old Render service or alter Supabase data as part of this recovery.
