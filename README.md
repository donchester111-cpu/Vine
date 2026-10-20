# Vine — integrated storefront and operations

Vine is a Nigerian online retail store. Vine owns the customer relationship, catalogue, order processing, supplier coordination, customer reviews, delivery workflow, and staff permissions. It is not a public seller marketplace.

This archive is the complete source for a **controlled deployment** of the current Vine code. It has not been deployed or pushed to GitHub by this archive-generation process. The live Supabase projects have been inspected and the listed database changes applied directly using the connected Supabase access. Payment configuration and checkout activation remain intentionally untouched.

## Project layout

- `Frontend/index.html` — customer storefront, categories, product details/gallery, verified-purchase reviews, product Q&A, cart and account dashboard.
- `Frontend/vineger.html` — private worker portal, product management, multi-image picker/live preview, orders, suppliers, persistent deliveries, customer-question inbox, notifications and passwordless staff access.
- `Frontend/vineowner.html` — private owner control centre for staff invitations, roles, permission assignments, overrides, audit and system checks. It is not linked from the public storefront.
- `services/accounts-api` — customer authentication/profile/address API and owner/staff management.
- `services/store-api` — product/category/review/Q&A/image APIs, catalogue permissions, inventory checks and checkout creation.
- `services/operations-api` — delivery records/history, verified payment webhooks, payment status, audits, sales analytics and the transactional-notification worker.
- `packages/shared` — security, RBAC, validation, CORS and shared transactional email.
- `supabase/migrations` — versioned SQL included for the order-tracking staff-assignment schema change; historical migration state remains recorded in each live Supabase project.

## Existing production service addresses

| Service | URL | Used for |
|---|---|---|
| Accounts API | `https://vine-fnoh.onrender.com` | Customer sessions, profiles, staff identity/roles and owner management |
| Store API | `https://vine-store-api.onrender.com` | Live product catalogue, images, reviews, Q&A, stock and product administration |
| Operations API | `https://vine-operations-api.onrender.com` | Orders, delivery history/status, verified sales analytics and notification delivery |

The browser uses only public URLs and the Supabase publishable key. Service-role keys, the owner password and session-signing secret belong only in private Render environment variables.

## Isolated Supabase projects

| Project | Ref | Responsibility |
|---|---|---|
| `vine_accounts` | `jktuwbgocpixtelfxzwq` | Supabase Auth, customer profiles/addresses, staff memberships, roles, permissions, owner settings and audit |
| `vine_products` | `xiehbdaaioifjcbnvpqf` | Products, categories, inventory reservations, supplier records, public product-image storage, reviews, helpful votes and Q&A |
| `vine_orders_payments` | `ybwdecxsbveiobfvwkvr` | Orders, order items, payments and provider events |
| `vine_operations` | `sqtntfnbjtguqddvvsly` | Delivery records/events, notification queue, operational audit, sales ledger and analytics |

Cross-project identity links intentionally use IDs verified by the owning API instead of pretending PostgreSQL can create foreign keys between separate Supabase projects.

## Integration state

The code now includes the Store API image upload route with the middleware initialized before its routes, public product detail/reviews/gallery and Q&A routes, staff catalogue routes for draft/published/archived products, database-backed delivery history, verified-purchase enforcement, and an email queue worker. This update adds a Vine-branded customer tracking panel inside each account order, an automatically refreshed milestone/history view, and Vineger controls for carrier, tracking reference, estimated arrival, courier contact and staff-only notes. After a payment is confirmed by the existing verified payment flow, the Operations API assigns the order to a randomly selected active non-owner staff member, creates a delivery timeline record, and reconciles recent paid-but-unassigned orders after an API restart. Staff who do not have global delivery-management permission can only see and update deliveries assigned to their own account. The owner account has an active membership in the configurable staff-role model; the invited staff account was confirmed active during the audit.

The live Render logs exposed earlier Store API deployment/start-up errors. This source archive keeps the image-upload middleware initialized before route registration. The Store API root now serves `Frontend/index.html` instead of returning an unhelpful not-found response, and catalogue reads are not blocked by a cleanup-only RPC failure. These code changes are only in this download until you deploy them; I have not written to GitHub or deployed the source from this session.

### One external credential is still required for real staff email

Passwordless staff sign-in and staff invitations generate secure Supabase magic/invite links server-side, then send them through Resend. The previous live failure was Supabase's built-in sender returning `429 email rate limit exceeded`. The source now returns a specific error when transactional mail is not configured, instead of hiding this as a generic sign-in failure.

Before email can actually be sent, the existing Render Accounts and Operations services need private environment variables:

- Optional Resend route: `RESEND_API_KEY` and `VINE_EMAIL_FROM` on a verified domain.
- Free Gmail API route: `GMAIL_SENDER_EMAIL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` on the Accounts and Operations services. The Accounts service also needs `GOOGLE_OAUTH_REDIRECT_URI=https://vine-fnoh.onrender.com/api/v1/email/google/callback`. Complete the connection only after this source has been deployed. Keep every secret only in Render, never in browser files or GitHub. Google refresh tokens from an external app left in Testing can expire, so this is not represented as a permanent production email setup.

No key or verified sender credential was available to this session, so none has been invented. A ZIP cannot make third-party email deliver without these provider credentials. After entering them in Render, use the private service logs and a real invited staff account to verify delivery. Supabase Auth's Site URL and redirect allowlist must include the actual `https://vinestore.com.ng/vineger.html` URL.

### Owner session agreement across services

The owner portal uses an HMAC-signed, short-lived owner session. Set the same `OWNER_SESSION_SECRET` (at least 32 bytes), `VINE_OWNER_USER_ID`, and `VINE_OWNER_EMAIL` in all three APIs. The owner user ID is the Supabase Auth ID in `vine_accounts`; the source default owner email is `donchester111@gmail.com`. The session can call only the explicitly allowed non-payment admin route prefixes; payment admin routes are excluded from the custom owner-session scope. Store/Operations private actions still run their database-backed RBAC checks.

Generate a shared random value locally or in a private secret manager; do not put it in this archive or in HTML. Never share secret keys in chat or commit them to a source repository.

## Environment required for the existing services

Use the actual live values in the private Render service environment; do not replace a working service key with a placeholder. The `render.yaml` and `.env.example` files document the variable names and project URLs but contain no secret values.

- Accounts service: `AUTH_SUPABASE_URL`, `AUTH_SUPABASE_ANON_KEY`, `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY`, `VINE_OWNER_EMAIL`, `VINE_OWNER_USER_ID`, `OWNER_SESSION_SECRET`, `OWNER_PASSWORD`, `VINE_STAFF_INVITE_REDIRECT_URL`, either Resend variables or Google Gmail OAuth variables, `GOOGLE_OAUTH_REDIRECT_URI`, `GMAIL_SENDER_EMAIL`, `ALLOWED_ORIGINS`.
- Store service: Accounts variables plus `PRODUCTS_SUPABASE_URL`, `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY`, `ORDERS_SUPABASE_URL`, `ORDERS_SUPABASE_SERVICE_ROLE_KEY`, `VINE_PRODUCT_IMAGES_BUCKET=vine-product-images`, `OWNER_SESSION_SECRET`, `VINE_OWNER_USER_ID`, `ALLOWED_ORIGINS`, `CHECKOUT_ENABLED` and `DELIVERY_FEE_KOBO`.
- Operations service: Accounts variables plus product, order and operations database URLs/service keys, owner-session agreement, either Resend variables or Google Gmail OAuth variables, `GMAIL_SENDER_EMAIL`, `ALLOWED_ORIGINS` and existing payment-provider configuration variables.

Set `ALLOWED_ORIGINS` to the exact deployed storefront origin(s), comma-separated, with scheme and hostname and no trailing slash. This is an existing browser CORS control, not a secret.

## Deployment checklist

1. Inspect the target service's current environment before merging values. Preserve its live Supabase service keys; do not replace them with `.env.example` blanks.
2. Deploy the source in this archive to the matching Render service paths/configuration. This archive-generation process does not write to GitHub or automatically trigger a deployment.
3. Configure the same owner-session values on all three APIs and configure a verified transactional sender in Resend. This is necessary for owner cross-service access and staff sign-in email delivery.
4. Verify the customer storefront at `https://vine-store-api.onrender.com/`, then verify each `/health` and `/ready` endpoint. From `vineowner.html`, run the authenticated service checks; a public health response alone does not prove protected API access.
5. Test invited-staff sign-in with a real email, then create/edit/archive a product, upload the main and gallery images, publish a customer question answer, create/update a delivery on a paid order, and inspect the audit/notification records.
6. Keep `CHECKOUT_ENABLED=false` until product sourcing, available stock, delivery coverage/fees, payment instructions/provider configuration, webhook and reconciliation checks are intentionally reviewed. Payment settings were not changed in this work.

## Checks

Run in the repository root:

```sh
npm test
npm run check
```

Static inline JavaScript in the HTML pages should also be parsed before deployment. The order-tracking integration includes contract tests for migration shape, paid-only assignment, random active-staff selection, customer-order scoping, assigned-staff authorisation, timeline persistence, auto-refresh, and the Vineger update controls.

## Important limitation

This is a full source integration package with live database changes applied, not a declaration that every external integration is live today. Email requires a real Resend key/verified sender, owner access requires matching Render secrets on all APIs, and the Store API source fix still needs controlled deployment and real endpoint/browser testing. Payment configuration intentionally remains outside this update.
