# Store Worker: Variables and Secrets

Set these in Cloudflare Dashboard → Workers & Pages → `store-api` → Settings → Variables and Secrets. Never place service-role keys or payment credentials in frontend code, Wrangler config, GitHub, or this ZIP.

## Required for Store API startup

- `AUTH_SUPABASE_URL` — `https://jktuwbgocpixtelfxzwq.supabase.co`
- `AUTH_SUPABASE_ANON_KEY` — public/publishable Auth-project key
- `ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Auth/Accounts Supabase project
- `PRODUCTS_SUPABASE_URL` — `https://xiehbdaaioifjcbnvpqf.supabase.co`
- `PRODUCTS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Products Supabase project
- `ORDERS_SUPABASE_URL` — `https://ybwdecxsbveiobfvwkvr.supabase.co`
- `ORDERS_SUPABASE_SERVICE_ROLE_KEY` — service-role key from the Orders/Payments Supabase project

## Required for Vineowner-managed endpoints

Use the same `OWNER_SESSION_SECRET`, `VINE_OWNER_EMAIL`, and `VINE_OWNER_USER_ID` as the Accounts Worker. `OWNER_SESSION_SECRET` must be at least 32 characters. For a frontend hosted somewhere other than `https://vinestore.com.ng` or `https://www.vinestore.com.ng`, set `ALLOWED_ORIGINS` to the comma-separated exact frontend origins.

## Feature settings

- `VINE_PRODUCT_IMAGES_BUCKET` — defaults in code to `vine-product-images` if omitted.
- `CHECKOUT_ENABLED` — keep `false` until the full live payment/order/webhook validation is complete.
- `DELIVERY_FEE_KOBO` — defaults to zero if omitted; set deliberately if Vine charges delivery.
- Payment secrets and provider settings belong on the API Worker that uses them, and do not need to be added here unless Store code explicitly uses them.

After saving settings, test `https://store-api.donchester111.workers.dev/health`, `/ready`, and the public product/category routes. `/ready` must succeed before testing login or checkout. Do not enable checkout merely because deployment succeeded.
