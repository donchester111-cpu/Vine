# Vine Cloudflare migration audit — free Workers revision

The current Cloudflare deployment files use standard Workers, not Cloudflare Containers. The existing Express API source and shared Supabase business logic are retained. Cloudflare's `cloudflare:node` `httpServerHandler` adapts the existing Node HTTP server to Workers. Operations queue/reconciliation work is invoked by a five-minute Cron Trigger rather than process-lifetime timers.

Checkout remains enabled in the Store Worker configuration (`CHECKOUT_ENABLED=true`); this is an API gate, not proof that live payment credentials, Supabase settings, or payment webhooks are configured correctly.

Before production cutover, configure all secrets in Cloudflare, verify each `/health` and `/ready` endpoint, test login and checkout, verify Paystack callback/webhook URLs, and update frontend API URLs and Google OAuth redirects. Do not delete Render until the Cloudflare deployments pass end-to-end tests.


## Build troubleshooting update (2026-10-21)

If Wrangler reports unresolved `express`, `zod`, or `@vine/shared/*` imports, the build is not installing the root npm workspace dependencies or is using a service subdirectory as its root. Set the Workers Builds root directory to the repository root and use `npm install && npx wrangler deploy --config cloudflare/<service>/wrangler.jsonc`. This is a build configuration issue; do not delete imports or rewrite service logic to hide it.
