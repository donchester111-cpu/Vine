# Accounts Worker: Variables and Secrets

Set these in Cloudflare Dashboard → Workers & Pages → `accounts-api` → Settings → Variables and Secrets. Never put service-role keys, passwords, OAuth refresh tokens, or provider secrets in browser code, Wrangler config, GitHub, or this ZIP.

## Required for database-backed API startup

- `AUTH_SUPABASE_URL` — `https://jktuwbgocpixtelfxzwq.supabase.co`
- `AUTH_SUPABASE_ANON_KEY` — the public/publishable Auth-project key used by Vine
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Auth/Accounts Supabase project

## Required for Vineowner login

- `OWNER_PASSWORD` — the owner login password
- `OWNER_SESSION_SECRET` — a private random secret of at least 32 characters; keep it the same on the Accounts, Store, and Operations Workers
- `VINE_OWNER_EMAIL` — the configured owner email
- `VINE_OWNER_USER_ID` — the configured owner's Supabase Auth user UUID

If the frontends are hosted somewhere other than `https://vinestore.com.ng` or `https://www.vinestore.com.ng`, set `ALLOWED_ORIGINS` to a comma-separated list of the exact allowed frontend origins. Do not include paths or trailing slashes.

## Optional integrations (do not block API startup)

For staff sign-in links and transactional emails, configure **one** working email provider:

- Resend: `RESEND_API_KEY` and `VINE_EMAIL_FROM`; or
- Gmail API: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and `GMAIL_SENDER_EMAIL`.

Other feature settings: `VINE_STAFF_INVITE_REDIRECT_URL` (defaults to `https://vinestore.com.ng/vineger.html`), `GOOGLE_OAUTH_REDIRECT_URI` (defaults to the Cloudflare callback documented in `cloudflare/README.md`), `PAYSTACK_SECRET_KEY` (only for features that use it), and `SMS_PROVIDER` (only if an SMS integration is implemented/configured). Leave optional provider settings unset until you have valid credentials; a blank optional provider must not stop login routes or `/health` from starting.

After saving settings, test `https://accounts-api.donchester111.workers.dev/health` and `/ready`. `/health` confirms the Worker can respond; `/ready` confirms the Accounts database can be queried. Owner login additionally requires the owner settings listed above.
