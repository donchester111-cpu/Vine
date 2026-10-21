# Vine storefront + Gmail repair — start here

> **Current deployment target:** Cloudflare Workers. Follow [`cloudflare/README.md`](cloudflare/README.md) for current build/deploy settings. The Render-specific instructions and incident notes below describe the previous deployment and are retained as historical context; do not use them to configure the current Workers.


This is a **source ZIP**, not a live deployment. It does not write to your GitHub repository, change Cloudflare Worker settings, or alter payment settings. Live services will continue using the old code until you deploy these files through your existing workflow.

## What was repaired

- `services/store-api/src/server.js` now serves the real storefront at `/` and `/index.html` instead of returning status JSON at the root. `https://store-api.donchester111.workers.dev/` will open the shopping page after this source is deployed.
- Catalogue reads continue if the inventory-reservation cleanup RPC fails temporarily; the error is logged without exposing database details.
- `packages/shared/src/db.js` includes the currently configured storefront origins in its default CORS allowlist. Unknown additional storefront domains still need an exact entry in `ALLOWED_ORIGINS`.
- Gmail API OAuth routes were added to Accounts API. The server verifies the returned Google email matches `vinestore1official@gmail.com` and shows the refresh token once on a private, no-store callback page.
- The frontend API URL configuration no longer gets blanked by an injected empty setting.
- Checkout remains disabled. No payment settings or payment activation code was changed.

## Deploy the source

1. Extract this ZIP. Open the `Vine` folder; do not put the entire folder inside another `Vine` folder in the repository. Keep the current paths such as `Frontend/`, `services/`, `packages/`, `supabase/`, and `tests/` at the repository root.
2. Upload/merge these files into your existing project using your own workflow. I have not written to GitHub.
3. Deploy Accounts, Store, and Operations using the matching explicit Wrangler commands in `cloudflare/README.md`. Keep the existing values in the Cloudflare dashboard; do not replace them with blanks from `.env.example` or move them into source files.
4. After the Store API deployment succeeds, open these URLs in a browser:
   - Storefront: `https://store-api.donchester111.workers.dev/`
   - Process health: `https://store-api.donchester111.workers.dev/health`
   - Database readiness: `https://store-api.donchester111.workers.dev/ready`
   - Published products: `https://store-api.donchester111.workers.dev/api/v1/products`
   - Active categories: `https://store-api.donchester111.workers.dev/api/v1/categories`

The custom domain `https://vinestore.com.ng` can remain on its existing static-site host; it does not automatically update just because Render is deployed. If that static site remains blank, redeploy `Frontend/index.html` to the existing static-site host as well.

## Finish the free Gmail setup

The code's exact OAuth callback route is:

`https://accounts-api.donchester111.workers.dev/api/v1/email/google/callback`

In the Google Cloud OAuth client screen you already opened:

1. Keep **Application type** as **Web application**.
2. Leave **Authorized JavaScript origins** empty.
3. Under **Authorized redirect URIs**, add the exact callback URL shown above (no trailing slash), then create the client.
4. Copy the client ID and client secret privately. Do not paste them into chat or place them in frontend files.
5. In Google Auth Platform, add `vinestore1official@gmail.com` under the audience's test users while testing.

After the updated Accounts API is deployed, set these variables in the **Accounts API** Render service:

- `GMAIL_SENDER_EMAIL` = `vinestore1official@gmail.com`
- `GOOGLE_OAUTH_CLIENT_ID` = client ID from Google Cloud
- `GOOGLE_OAUTH_CLIENT_SECRET` = client secret from Google Cloud
- `GOOGLE_OAUTH_REDIRECT_URI` = `https://accounts-api.donchester111.workers.dev/api/v1/email/google/callback`

Then, while signed into that Gmail account, open:

`https://accounts-api.donchester111.workers.dev/api/v1/email/google/connect`

Approve the Gmail sending permission. The callback page verifies the account and displays a refresh token once. Copy it directly into `GOOGLE_OAUTH_REFRESH_TOKEN` in the Cloudflare dashboard for **both Accounts and Operations Workers**. Ensure the required existing `GMAIL_SENDER_EMAIL`, `GOOGLE_OAUTH_CLIENT_ID`, and `GOOGLE_OAUTH_CLIENT_SECRET` settings are present on the relevant Cloudflare Workers. Never send the refresh token in chat or commit it to GitHub.

Register `https://accounts-api.donchester111.workers.dev/api/v1/email/google/callback` as an authorized redirect URI in the Google OAuth client. The Cloudflare callback must match exactly.

**Important limitation:** Gmail's `gmail.send` scope is sensitive. Google permits personal/development testing without verification in certain circumstances, but apps left in Testing have limited refresh-token lifetimes. Do not assume this is a permanent, production-grade sender until the Google publishing/verification status is resolved. The final test is sending a real Vineger sign-in link to an invited staff account.
