# Vine release package notes

This release contains the active shopper storefront (`Frontend/index.html`), staff portal (`Frontend/vineger.html`), owner control centre (`Frontend/vineowner.html`), the three Node/Express APIs, shared authentication/security/RBAC/email code, tests, render blueprint, documentation and Supabase migration history for all four projects.

## Database state

The connected Supabase projects were inspected directly. Product image storage, reviews, Q&A, saved-item persistence, owner staff membership, and `rls_auto_enable()` execution-permission lockdown were applied and verified through the connected Supabase tools. No manual SQL step is left for the owner. On future database work, inspect the correct project and apply migrations through the connected integration when available.

## Safe handling

- No Git history is included.
- No real `.env` file or service credentials are included.
- `render.yaml` has auto-deploy disabled; this archive has not been pushed or deployed by this packaging step.
- Checkout remains disabled (`CHECKOUT_ENABLED=false`); payment configuration is intentionally unchanged.
- Obsolete duplicate storefronts, duplicate API clients, old deployment notes and archived mockups are excluded from the deployable release tree.
- `docs/PRODUCTION_READINESS.md` identifies completed checks and the external prerequisites that are not verifiable from source alone.

## Validation

- `npm test`: 37 passing tests.
- `npm run check`: all backend syntax checks pass.
- Inline JavaScript syntax and duplicate HTML ID checks pass for all three active pages.


## 2026-10-19 storefront/email fix package

- The Store API root (`/`) and `/index.html` serve the actual `Frontend/index.html` page, including a CSP suitable for its inline application script and HTTPS APIs. The canonical static-site deployment remains supported.
- The public product list no longer fails entirely if the inventory-expiry cleanup RPC temporarily returns an error; it logs a sanitized warning and keeps catalog reads available. Inventory reservation operations remain server-side.
- CORS defaults allow the configured production storefront domain and the Store API root origin; unknown origins still require explicit `ALLOWED_ORIGINS`.
- Gmail OAuth routes are included but remain unconfigured until owner-created Google OAuth credentials are stored privately in Render and an actual delivery is tested. The package does not include credentials or alter payment settings.
