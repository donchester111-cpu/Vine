# Vine Cloudflare migration audit — 2026-10-20

## Current source state

- Three Node.js 22-compatible Express APIs in a single npm-workspaces monorepo.
- Existing runtime port is `process.env.PORT || 10000`; APIs bind to `0.0.0.0` and expose `/health` and `/ready`.
- Four separate Supabase projects are used; they remain external and unchanged.
- Operations API starts its notification queue polling every 30 seconds when email delivery is configured and runs delivery reconciliation after startup. Queue records are persisted in Supabase.
- Frontend HTML and OAuth callback settings contain Render URLs that require a deliberate post-deploy cutover.
- Checkout is disabled in the source configuration and must remain disabled during the migration.

## Baseline validation

- `node --test tests/*.test.js`: 13 tests passed.
- `npm run check`: passed.

## Migration boundary

The Cloudflare files are new deployment wrappers and Dockerfiles. Existing application routes and business logic are unchanged. New Cloudflare endpoints must be tested before frontend URLs and OAuth callback settings are switched.
