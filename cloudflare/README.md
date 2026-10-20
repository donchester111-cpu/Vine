# Vine Cloudflare Containers migration scaffold

This folder adds deployment infrastructure only. It does not replace the existing APIs or alter their business logic. Three independent Workers route to three Linux containers so the current API boundaries and per-service environment settings remain separate. Supabase remains the database.

## Important before deploying

- Cloudflare Containers require the Workers Paid plan. Current published pricing starts at $5 USD/month plus usage. Three containers kept active by frequent uptime checks can add memory, CPU and network charges; inspect current Cloudflare pricing before turning on keep-alive monitoring.
- An uptime monitor can refresh the inactivity timeout, but it cannot guarantee an uninterrupted process. Cloudflare may restart containers for host maintenance or deployments. The Operations API's notification queue is persisted in Supabase, and its worker should resume after the process restarts.
- Do not remove or shut down Render yet. Deploy these as staging services, set secrets privately, test, then switch API URLs and OAuth callbacks.
- The three API URLs on `workers.dev` are assigned by Cloudflare and depend on the account's Workers subdomain. The frontend still points to Render until the final cutover; do not guess the new URLs.
- `GOOGLE_OAUTH_REDIRECT_URI` currently retains the Render callback as a staging placeholder. After Cloudflare assigns the Accounts API URL, update this value and the exact Authorized Redirect URI in Google Cloud before testing email OAuth.
- `ALLOWED_ORIGINS` is not guessed in these files. Copy the current value from each Render service and include the actual storefront origin.
- Checkout stays disabled (`CHECKOUT_ENABLED=false`). Do not activate payments as part of the hosting migration.

## Files added

- `Dockerfile.accounts`, `Dockerfile.store`, `Dockerfile.operations`: separate container images from the existing monorepo.
- `cloudflare/accounts`, `cloudflare/store`, `cloudflare/operations`: separate Worker entrypoints and Wrangler configurations.

## Deployment order

1. Confirm the Cloudflare account has Workers Paid and Containers enabled.
2. Deploy Accounts API first; configure its private secrets from `accounts/SECRETS_TO_CONFIGURE.md` and test `/health` and `/ready`.
3. Deploy Store API; configure secrets and test `/health`, `/ready`, `/api/v1/products`, and `/api/v1/categories`.
4. Deploy Operations API; configure secrets and test `/health`, `/ready`, delivery routes, payment status, and notification queue recovery.
5. Set a monitor for each deployed `/health` endpoint every 5 minutes (shorter than the configured 15-minute inactivity timeout). This is a keep-alive aid, not an uptime guarantee.
6. Only after staging tests pass, update frontend API base URLs in all four HTML pages, update the Google OAuth callback, test CORS and email delivery, and switch the production traffic. Keep Render available until all checks pass.

## Environment variables

Public/non-secret values are prefilled where the current archive establishes them. Set all required secrets through Cloudflare Worker settings. Email-provider values are optional only if the corresponding provider is intentionally not configured; `OWNER_PASSWORD` is optional if owner bootstrap is not being used. Preserve the exact current production values for owner IDs, owner-session secret, Supabase service-role keys, payment settings, sender credentials, and `ALLOWED_ORIGINS`. Never send secrets in chat or place them in frontend files.
