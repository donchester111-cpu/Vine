# Vine release package notes

This release contains the active shopper storefront (`Frontend/index.html`), staff portal (`Frontend/vineger.html`), owner control centre (`Frontend/vineowner.html`), the three Node/Express APIs, shared authentication/security/RBAC/email code, order-tracking contract tests, render blueprint, documentation and the added Supabase migration for delivery staff assignment.

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

- `npm test`: order-tracking contract tests run with Node’s built-in test runner.
- `npm run check`: all backend syntax checks pass, including the new tracking route module.
- Inline JavaScript syntax checks pass for all three active pages.


## 2026-10-20 order tracking + staff assignment

- Added customer-specific order tracking inside the storefront account order list, including a Vine-green milestone rail, estimated arrival, carrier/reference, item snapshots, delivery destination, safe tracking history and a 15-second refresh while the panel remains open.
- Added Vineger delivery editing for carrier/tracking code, ETA, courier name/phone, internal notes and status changes. Customer APIs do not return internal notes or staff identities.
- Verified paid orders are automatically assigned to a randomly chosen active non-owner staff account. Assigned staff receive a restricted view/update scope; existing authorised delivery managers keep their wider scope. A startup reconciliation assigns recent paid orders that do not yet have an owner.
- Applied Supabase migration `20261020020608_add_order_tracking_staff_assignment` directly to `vine_operations` and verified `assigned_staff_id` and `assigned_at` are present. The source/API/frontend update is packaged here only; it was not pushed to GitHub or deployed to Render.

## 2026-10-19 storefront/email fix package

- The Store API root (`/`) and `/index.html` serve the actual `Frontend/index.html` page, including a CSP suitable for its inline application script and HTTPS APIs. The canonical static-site deployment remains supported.
- The public product list no longer fails entirely if the inventory-expiry cleanup RPC temporarily returns an error; it logs a sanitized warning and keeps catalog reads available. Inventory reservation operations remain server-side.
- CORS defaults allow the configured production storefront domain and the Store API root origin; unknown origins still require explicit `ALLOWED_ORIGINS`.
- Gmail OAuth routes are included but remain unconfigured until owner-created Google OAuth credentials are stored privately in Render and an actual delivery is tested. The package does not include credentials or alter payment settings.
