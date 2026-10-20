# Vine storefront and operations hardening

This archive contains the Vine project source with the storefront, Vineger staff console, Vineowner control centre, account/order tracking, and operations delivery safety changes.

## Changes in this release

- **Delivery continuity:** paid orders are assigned to a randomly selected active, non-owner staff member. The Operations API reconciles open deliveries whose assignee is no longer active. It transfers them to another active team member, or to the verified owner assignment when no eligible staff member is available. Transfers add a delivery timeline event and audit record. Owner-initiated staff suspension also requests an immediate handover. The periodic reconciliation remains as a recovery path if the immediate handover call fails.
- **Assigned staff guard:** staff members who do not have broader delivery-management permissions can update only deliveries currently assigned to them. The API rechecks assignments before delivery writes.
- **Storefront catalogue:** the catalogue has a branded editorial showcase, clearer product-card hierarchy, and better mobile presentation.
- **Customer account:** reorganized profile, account statistics, shortcuts, addresses, saved items, reviews, questions, and orders into a more legible workspace. Existing order tracking remains included.
- **Vineger product workflow:** product creation/editing is a separate workspace from the product library. The library uses server-side search, status filtering, 50-item pages, and explicit previous/next controls so the add-product action is not buried beneath a long catalogue.
- **Vineowner workspace:** added a command-style overview hero, clearer panel hierarchy, improved spacing and contrast, and a staff-suspension handover action.
- **User-facing errors:** generic action and backend failures now provide a safe next step and, where available, a support reference instead of exposing implementation details.
- **Checkout safety:** the live `vineowner_settings.commerce.checkoutEnabled` flag is held at `false`. `render.yaml` also retains `CHECKOUT_ENABLED: "false"`, and the Store API requires both controls to be explicitly enabled. Do not enable checkout until a real end-to-end purchase test confirms payment verification, order creation, stock reservation/release, duplicate webhook handling, and delivery assignment.

## Verification

The local project checks at packaging time are:

```sh
npm test
npm run check
```

The integration-contract suite contains 13 tests covering payment-gated assignment, customer order ownership, staff assignment permissions, inactive-assignee handover, product library pagination/workspace separation, storefront/account redesign contracts, owner-console errors, and checkout safety gates.

## Deployment boundary

Required Supabase SQL was applied directly to the intended Supabase projects and the delivery assignment columns were verified. Source migrations are included under `supabase/migrations/`.

This archive is a source release. The updated application code has **not** been deployed to Render, and no GitHub content has been changed by this work. Deploy the relevant services through the project's approved release process only after reviewing the ZIP and configuring the deployment from its source. The production checkout safety gate should stay closed until the purchase lifecycle has passed its smoke tests.
