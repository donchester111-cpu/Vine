# Vine Store — backend foundation (v0.1)

This is the first backend implementation for **Vine, an online retail store**. Vine owns the customer relationship, order, payment, supplier coordination, and delivery experience. There is no public seller registration or independent seller storefront.

**This package has not been deployed.** It contains server code and SQL migrations only. The SQL files must be applied manually to the correct Supabase project. The Render blueprint is only a configuration file; do not provision it until the setup checklist below is complete.

## Architecture

Three Node.js/Express services run independently on Render:

- `vine-accounts-api`: Supabase Auth session endpoints, profiles, customer addresses, and role checks.
- `vine-store-api`: public catalogue API, private catalogue/supplier administration, stock reservations, checkout/order creation, and customer order history.
- `vine-operations-api`: Paystack initialization and verified webhooks, manual bank-transfer confirmation, delivery tracking, audit records, notification queue, and daily paid-sales analytics.

The four Supabase projects keep different concerns isolated:

| Supabase project | Project ref | Owned data |
|---|---|---|
| `vine_accounts` | `jktuwbgocpixtelfxzwq` | Supabase Auth, customer profiles/addresses, private staff roles |
| `vine_products` | `xiehbdaaioifjcbnvpqf` | Catalogue, product stock, suppliers and private supplier pricing, reservations |
| `vine_orders_payments` | `ybwdecxsbveiobfvwkvr` | Order/address snapshots, order items, payment attempts and provider events |
| `vine_operations` | `sqtntfnbjtguqddvvsly` | Deliveries, audit trail, notification queue, paid-sales ledger/analytics |

Because those are four different databases, PostgreSQL cannot enforce foreign keys across them. The APIs validate account ownership and product IDs; order rows keep immutable product/price and delivery-address snapshots. Treat cross-project validation as a critical boundary.

## Before running anything

1. Keep `CHECKOUT_ENABLED=false` until product sourcing, stock quantities, delivery pricing, Paystack keys/webhook, and bank transfer instructions are confirmed.
2. Do **not** share a Supabase `service_role`/secret key in chat, HTML, GitHub, screenshots, or `.env.example`. Store it only as a private Render environment variable.
3. The Supabase project URLs in `.env.example` and `render.yaml` are identifiers, not keys. The `AUTH_SUPABASE_ANON_KEY` is the public client key used for Supabase Auth calls; server service-role keys bypass RLS and must remain secret.
4. Use a new GitHub repository or an existing private repository for this project. Do not put it in the StudentNija repository unless you deliberately want to mix the projects.

## Database setup — one project at a time

Open each project's **SQL Editor** in Supabase and run only its matching file. Apply in this order so you can stop and investigate any failure before continuing:

1. Project `vine_accounts`: `supabase/migrations/vine_accounts/001_accounts.sql`
2. Project `vine_products`: `supabase/migrations/vine_products/001_products_inventory.sql`
3. Project `vine_orders_payments`: `supabase/migrations/vine_orders_payments/001_orders_payments.sql`
4. Project `vine_operations`: `supabase/migrations/vine_operations/001_operations_analytics.sql`

These scripts create tables/functions/policies; they do not insert product stock, apply real supplier records, create payment credentials, or enable checkout. Product and supplier seed data are deliberately not fake-filled.

### Supabase Auth settings

In the `vine_accounts` project, configure Auth's site URL and allowed redirect URLs after the storefront URL is known. Leave email confirmation enabled unless you deliberately decide otherwise. The signup endpoint creates Auth users; the database trigger creates the matching profile.

### Bootstrap the first Vine owner (after SQL is installed)

First register the intended owner using Vine's signup screen after the accounts API is running, or create that user through Supabase Auth. Then run the following in the `vine_accounts` SQL Editor after replacing the email with the exact owner email:

```sql
insert into public.admin_roles(user_id, role)
select id, 'owner'
from auth.users
where lower(email) = lower('owner@example.com')
on conflict (user_id, role) do nothing;
```

Verify that one row was inserted. **Do not expose a public endpoint that lets a user assign themselves the owner/admin role.** Later staff roles should be granted deliberately from the SQL Editor or an audited owner-only administration flow.

## Server configuration

Copy `.env.example` to `.env` only for local development. Never commit the actual `.env` file. All service keys are currently blank by design.

For Render, provide variables on each service individually:

### `vine-accounts-api`

- `AUTH_SUPABASE_URL` — already set in `render.yaml` to `vine_accounts`.
- `AUTH_SUPABASE_ANON_KEY` — the public/anon key from `vine_accounts`.
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY` — private service-role/secret key from `vine_accounts`.
- `ALLOWED_ORIGINS` — exact storefront origin(s), comma-separated; no wildcard in production.

### `vine-store-api`

- `AUTH_SUPABASE_URL`, `AUTH_SUPABASE_ANON_KEY`, `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY` as above.
- `PRODUCTS_SUPABASE_URL`, `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY` from `vine_products`.
- `ORDERS_SUPABASE_URL`, `ORDERS_SUPABASE_SERVICE_ROLE_KEY` from `vine_orders_payments`.
- `ALLOWED_ORIGINS`, `CHECKOUT_ENABLED=false`, and `DELIVERY_FEE_KOBO`.

### `vine-operations-api`

- The account/products/orders variables above, plus `OPERATIONS_SUPABASE_URL` and `OPERATIONS_SUPABASE_SERVICE_ROLE_KEY` from `vine_operations`.
- `PAYSTACK_SECRET_KEY` — private secret from Paystack; absent means online payment initialization is unavailable.
- `PAYSTACK_CALLBACK_URL` — the public storefront URL to return to after Paystack redirects back.
- `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_ACCOUNT_NAME`, `BANK_TRANSFER_ACCOUNT_NUMBER` — the business account details to show to customers. Account number must be ten digits.
- `ALLOWED_ORIGINS` — the same precise storefront origin(s).

Use only the correct project's key for each database. Do not paste any of these service-role keys into the storefront's `window.VINE_CONFIG`.

## Render staging deployment (not performed)

`render.yaml` describes the three independently hosted services and sets the correct start and health-check commands. It has auto-deploy disabled. Creating/provisioning a Blueprint can create public services, so wait until the SQL migrations are applied and all required environment values are ready. On every service set the final `ALLOWED_ORIGINS` value; without the final storefront domain, browser CORS will not work.

The services bind to `0.0.0.0:$PORT` and expose `/health` for Render health checks. The `/ready` route checks relevant Supabase tables. See the current [Render web-service docs](https://render.com/docs/web-services) and [health-check docs](https://render.com/docs/health-checks). Free Render services are useful for staging but have availability/idle limitations; do not assume they provide production-grade uptime for payment webhooks.

## Connect the storefront

The ready-to-edit storefront is `frontend/vine_store_v3_backend_ready.html`. It includes the previous Vine design, a customer sign-in/sign-up modal, shipping form, Paystack redirect flow, manual bank transfer instructions, and live catalogue loading. It deliberately ships with blank API URLs and retains the demo catalogue only while URLs are blank.

When all three services are deployed and health-checked, edit the single `window.VINE_CONFIG` object near the top of its main script:

```js
window.VINE_CONFIG = {
  accountsApiBaseUrl: 'https://vine-accounts-api.onrender.com',
  storeApiBaseUrl: 'https://vine-store-api.onrender.com',
  operationsApiBaseUrl: 'https://vine-operations-api.onrender.com'
};
```

Replace those hostnames with the actual Render URLs. The external copy of the API adapter is `frontend/vine-api-client.js`; the connected HTML is already self-contained and inlines the same adapter. Deploy only one copy of the storefront. Browser sessions use `sessionStorage` in this first version; before scaling the store, harden the frontend/session architecture and deploy a strict CSP to reduce exposure to XSS.

## Payment and stock flow

1. The browser sends product IDs and quantities, never an authoritative amount.
2. Store API loads published products/prices from `vine_products`, validates the address against `vine_accounts`, reserves the stock through a database function, and writes the order/items/payment row through one transaction in `vine_orders_payments`.
3. Operations API checks order ownership and amount, then either returns bank-transfer instructions or asks Paystack to initialize a transaction.
4. Paystack's webhook must match the HMAC-SHA512 signature of the **raw** request body. The service then verifies the transaction directly with Paystack, checks amount/currency/reference, commits reserved stock and updates the order. Browser redirect alone never marks an order paid.
5. Bank transfers remain pending until a trusted staff member verifies the incoming transfer in the actual bank account and uses the staff-only confirmation endpoint.
6. When payment is verified, a unique sales ledger records the order once, updates daily analytics, and queues a customer notification job.

Set the Paystack webhook URL in the Paystack dashboard to:

`https://<actual-vine-operations-api-host>/api/v1/webhooks/paystack`

Keep test credentials and real payment credentials separate. Test with Paystack test mode first. Do not use real customer money until payment reconciliation, delivery pricing, bank details, stock reservation expiry, and refunds have been tested end to end.

## What is included / what remains

**Included in this first backend package:** three service entry points; separate per-project SQL; Supabase Auth integration; self-owned profiles/addresses; product/category APIs; supplier and wholesale-cost tables and staff APIs; customer checkout/order history/cancellation; stock reserve/release/commit functions; Paystack initialize/verify-webhook flow; manual transfer verification endpoint; delivery status transitions; audit trail; paid-sales analytics; a notification-job queue; one-file storefront integration.

**Still required before live business:** apply and inspect all four SQL migrations; configure Supabase Auth and RLS; create the owner account and add its role; deploy and health-check each service; set exact CORS origins; configure Paystack and webhook; set real supplier/product/stock data and delivery fees; implement an actual email/SMS delivery worker/provider; build a dedicated staff/admin dashboard; test refunds and late-payment/stock edge cases; review the final system with security and payment compliance requirements. Flutterwave is not yet wired to a live adapter in this initial version.

The package is a working implementation foundation, not a claim that live ordering is operational yet. Checkout is explicitly disabled until those prerequisites are complete.
