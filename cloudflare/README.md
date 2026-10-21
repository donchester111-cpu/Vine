# Vine — Cloudflare Workers deployment

Vine runs three separate Cloudflare Workers and continues to use Supabase for its data stores. The current frontend files already point to the Cloudflare API URLs.

## Build and deploy

For each Worker, configure the Workers Build root directory as the repository root (the folder containing `package.json`, `packages/`, and `services/`). Do not set the build root to a `cloudflare/*` subfolder because the shared `@vine/shared` package is a root workspace dependency.

Use the explicit Wrangler config for the Worker you are deploying:

- Accounts: `npx wrangler deploy --config cloudflare/accounts/wrangler.jsonc`
- Store: `npx wrangler deploy --config cloudflare/store/wrangler.jsonc`
- Operations: `npx wrangler deploy --config cloudflare/operations/wrangler.jsonc`

Do not rely on an implicit default Wrangler config. Keep the root workspace dependency install/build setup that is already working in Cloudflare; do not add a second package installation step if the configured build already installs workspace dependencies.

## Environment variables and secrets

The three Wrangler config files intentionally contain **no `vars` block and no secret values**. They now set `keep_vars: true` so plain-text variables configured in the Cloudflare dashboard are preserved on subsequent Wrangler deployments. Cloudflare secrets are also preserved across deployments. Keep values in Cloudflare Dashboard → Worker → Settings → Variables and Secrets. The project source is designed to read those bindings through `process.env`; all three Worker configs explicitly enable `nodejs_compat_populate_process_env`.

Do not copy secrets into Wrangler files, frontend HTML, GitHub, or this ZIP. If a Worker returns a configuration error, inspect its existing dashboard bindings rather than creating values in source files. See the matching `SECRETS_TO_CONFIGURE.md` file for variable names only.

## Checkout

`CHECKOUT_ENABLED` is read from the Store Worker environment configured in the Cloudflare dashboard; it is not hard-coded in the Wrangler file. Checkout also requires the database checkout setting, enabled payment method, valid provider configuration/webhook, inventory functions, and order database settings. Verify using a controlled test before taking production orders.

## Operations schedule

The Operations Worker cron trigger is configured to run every five minutes (`*/5 * * * *`) for notification processing and delivery/staff reconciliation. This replaces process-lifetime timers, which are not reliable background-job mechanisms on Workers.

## Google OAuth callback

The fallback callback is `https://accounts-api.donchester111.workers.dev/api/v1/email/google/callback`. The existing `GOOGLE_OAUTH_REDIRECT_URI` dashboard setting is still respected unless it contains a legacy `onrender.com` URL; that legacy URL is ignored in favor of the Cloudflare callback. Make sure the matching callback is also registered with the Google OAuth client. No new environment variable is introduced by this package.

## Verification

1. Deploy Accounts and check `/health` and `/ready`.
2. Deploy Store and check `/health`, `/ready`, product/category endpoints, and checkout gates.
3. Deploy Operations and check `/health`, `/ready`, payment status, and delivery routes. Confirm the five-minute cron trigger is present in Worker settings.
4. Test the Vineowner and Vineger portals with a real authorized account. If a request still fails, use the failed request's status and the corresponding Worker log rather than assuming a successful `/health` request proves the portal call succeeds.
5. Keep a prior deployment available until authenticated owner, staff, storefront, and controlled checkout checks pass.
