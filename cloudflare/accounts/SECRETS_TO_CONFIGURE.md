# Private Worker settings

Set these as **Worker secrets** in the Cloudflare dashboard. Never commit their values.

- `AUTH_SUPABASE_ANON_KEY`
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY`
- `VINE_OWNER_USER_ID`
- `OWNER_SESSION_SECRET`
- `OWNER_PASSWORD`
- `RESEND_API_KEY`
- `VINE_EMAIL_FROM`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `ALLOWED_ORIGINS`

Also copy the current value of `ALLOWED_ORIGINS` from the existing Render service. Do not replace it with an invented value. Keep `CHECKOUT_ENABLED=false` on Store API until the purchase flow is fully tested.
