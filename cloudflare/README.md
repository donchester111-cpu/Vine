# Vine — Cloudflare Workers (free-plan deployment)

This version removes Cloudflare Containers and Docker deployment. Each API runs as a standard Cloudflare Worker using Cloudflare's Node.js HTTP server adapter for the existing Express application. Supabase remains the database, and the Store Worker keeps `CHECKOUT_ENABLED` set to `true`.

## Workers and deployment settings

Create/deploy three separate Workers from the same GitHub repository. In Cloudflare Workers Builds, set the **Root directory to the repository root** (leave it blank if the dashboard treats blank as root), because Vine uses npm workspaces and shared code under `packages/shared`.

Use these individual build/deploy commands:

- Accounts: `npx wrangler deploy --config cloudflare/accounts/wrangler.jsonc`
- Store: `npx wrangler deploy --config cloudflare/store/wrangler.jsonc`
- Operations: `npx wrangler deploy --config cloudflare/operations/wrangler.jsonc`

The Worker names in the configs are `accounts-api`, `store-api`, and `operations-api`. If the dashboard-created Worker names differ, either rename the dashboard Worker or change the corresponding `name` field to exactly match it.

## Required secrets

Configure the existing secrets in each Worker using the Cloudflare dashboard's **Settings → Variables and Secrets**. Use the matching `SECRETS_TO_CONFIGURE.md` file in each service folder. Never commit secrets or paste them into chat. Existing public variables from the prior staging configuration have been retained.

Keep the exact production values for Supabase service-role keys, owner identity/session credentials, payment keys, email credentials, and `ALLOWED_ORIGINS`. Set all required variables before testing `/ready`.

## Checkout

`cloudflare/store/wrangler.jsonc` keeps `CHECKOUT_ENABLED` set to `true`. This only enables the API's environment gate. Checkout still depends on the existing Supabase commerce settings, payment method configuration, Paystack credentials/webhook setup, inventory functions, and order database settings. Test with a non-live/small controlled transaction before switching production traffic.

## Operations background tasks

The Operations Worker uses a Cloudflare Cron Trigger every five minutes to run the notification queue and delivery/staff reconciliation. This replaces process-lifetime timers, which are not a reliable background-job mechanism on Workers. The job logic remains in the existing Operations API source.

## Verification and cutover

1. Deploy Accounts, then test `/health` and `/ready`.
2. Deploy Store, then test `/health`, `/ready`, product/category endpoints, and checkout in a controlled test.
3. Deploy Operations, then test `/health`, `/ready`, payment status and delivery routes. Confirm the cron trigger appears under the Worker settings.
4. Update frontend API base URLs and the Google OAuth callback only after Cloudflare gives you the final Worker URLs. Update the matching Google OAuth authorized redirect URI too.
5. Keep the old Render deployment available until all tests pass. Do not switch live traffic based only on a successful build.

## Free-plan notes

This uses ordinary Workers and does not declare Containers or Durable Objects. Usage is still subject to Cloudflare's current Workers Free plan limits. The Workers Free plan is not a guarantee of unlimited traffic or uninterrupted execution.
