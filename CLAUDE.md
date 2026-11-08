@AGENTS.md

# virtify.net — Hosting Billing Panel

This repo is a self-built billing, client-management and provisioning panel for a hosting
company (VPS, web hosting, later game servers). Think WHMCS/Blesta/Paymenter, but modern.
The operator is based in Germany and is currently a **Kleinunternehmer (§ 19 UStG)** → no VAT is
charged today, but the tax layer must be pluggable so regular VAT can be switched on later.

The panel is the product. `(marketing)` is the public storefront in front of it, not the point of
the project — do not grow it beyond what checkout needs.

The build is planned in phases: see `docs/BUILD_PLAN.md`, state in `docs/PROGRESS.md`.

## Stack (do not swap without asking)

- **Next.js** 16 (App Router, RSC, Server Actions), React 19, TypeScript `strict`
- **shadcn/ui** (style `base-nova`, on **Base UI** — not Radix) + Tailwind CSS 4, `lucide-react`
- **Drizzle ORM** + **PostgreSQL** (`drizzle-kit generate` for migrations, never `push` in prod)
- **Better Auth** (Drizzle adapter): email/password, TOTP 2FA, sessions; separate instances for
  clients and staff
- **zod** at every boundary (forms, server actions, API routes, webhooks, env)
- **OpenAPI 3.1** generated from zod (`@asteasolutions/zod-to-openapi`), rendered with **Scalar**
  at `/api/docs`
- **IDs: ULID**, prefixed (`invoice_01K…`) — see hard rule 1
- Jobs: **pg-boss** in `src/server/jobs`, run by a **separate worker process** (`npm run worker`,
  or the Dockerfile's `worker` target). It is in the build plan for Phase 6; the alternative — a
  timer inside the Next server — runs once per instance and is killed mid-pass by a redeploy
- Payments: **Stripe** + **PayPal** + bank transfer, all behind one `PaymentGateway` interface
  in `src/server/payments/gateways`; credentials encrypted in `payment_gateway_setting`, with
  the environment as the fallback · PDF: `@react-pdf/renderer` · GiroCode: `qrcode-generator`
  (zero dependencies; writing a QR encoder by hand means Reed-Solomon and mask selection with
  nothing to validate against, on a code that asks for money) · Mail: nodemailer/SMTP today,
  Microsoft Graph from Phase 7
- **Vitest** for unit/integration tests; Playwright for e2e from Phase 11
- Formatter/linter: **Biome** (4 spaces, double quotes, trailing commas)
- Package manager: **npm** · Local DB via `npm run db:up` (Docker) · Deploy target: Dokploy

### Deviations from the original brief, and why

| Brief | Here | Reason |
|---|---|---|
| pnpm | npm | The repo and its lockfile are npm; switching buys nothing. |
| `id char(26)` bare ULID | `text` `prefix_ULID` | Already in every table and in every stored Stripe/PayPal reference. The prefix is constant per table, so ULID cursor pagination still works. |
| ESLint + Prettier | Biome | Already configured, one tool instead of two. |
| `react-hook-form` | server actions + `useActionState` | No client form library in the repo; forms post to server actions. |
| Middleware for `/admin/**`, `/client/**` | layout + guard helpers | The guards already refuse server-side against the database on every request. Middleware could only check that a cookie is present. |
| Postgres 17 | Postgres 18 | Dev container already runs 18. |

## Project layout

```
src/
  app/
    (marketing)/        # public storefront, /cart, /checkout, legal pages
    (client)/client/     # customer portal
    (admin)/admin/       # staff panel
    api/v1/              # public REST API (API-key auth), every route in the OpenAPI registry
    api/docs/            # Scalar API reference
    api/webhooks/        # stripe, paypal, msgraph
  db/
    schema/              # one file per domain, re-exported from index.ts
    schema/_columns.ts   # shared helpers: ulidPk(), ulidFk(), timestamps(), money()
  server/                # domain logic, NO React here
    customers/  auth/  api/  api-keys/  audit/  documents/  payments/
    catalog/  billing/  tax/  storage/  provisioning/  tickets/  jobs/  openapi/
  subscriptions/       # the state machine, plan changes, the guards around both
    payments/gateways/   # stripe, paypal, banktransfer — one interface, three bodies
  cart/  orders/           # the cart, and the one transaction that makes it an order
  lib/                   # money, crypto, ulid, env, utils — framework-free
  components/            # shadcn (components/ui, not linted) + shared app UI
```

One price, one function: `src/server/billing/pricing.ts` computes every quote the storefront,
the cart, the checkout and `POST /api/v1/products/{id}/quote` show. A second implementation
anywhere — including in the browser — is how a shown price starts disagreeing with a charged
one. A cart row therefore holds a *configuration* and no amounts at all; an order row holds the
amounts, written by that same function inside the transaction that also writes the invoice.

One document arithmetic, one function: `src/server/billing/invoices/totals.ts` computes every
total an invoice, a credit note or an offer shows. The rendered PDF of a finalized document is
written once and kept in `src/server/storage`; it is never re-rendered on request, so a change
to the template cannot restyle a document the customer already holds.

One settlement, one function: `applyPayment()` in `src/server/payments/apply.ts` is the only
place money meets a document. A Stripe webhook, a PayPal capture, a customer's return from a
hosted page, a transfer booked by hand and credit being spent all end there, and none of them
recomputes what is owed — `invoice.gross_cents` and `credited_cents` say that, and
`src/server/payments/settlement.ts` is the pure arithmetic that turns them plus "what arrived"
into a status. Two settlement paths is how an invoice gets paid twice by mechanisms that do not
know about each other, which is also why **bank transfer is a gateway** rather than a status
somebody sets.

Money moves in two directions, and **every rule that touches the balance has to be written in
both**. A refund puts back whatever its charge did to `credit_ledger` — a refunded top-up
debits it, a reversed credit payment re-credits it — and the overshoot a payment creates is
taken back by `bookOvershootDelta`, the *same* function that granted it, called by
`settleAgainstInvoice` and `resettleInvoice` alike. Writing such a rule only on the way in is
how a refunded top-up leaves the customer the cash *and* the credit. Each entry is keyed on the
row that caused it — the payment, or the refund — so the unique index on
`credit_ledger (payment_id, kind)` makes a repeat a no-op rather than a doubled balance.

One recurring run, one function: `runBilling()` in `src/server/billing/run.ts` is the daily
pass — trials end, renewals are invoiced ahead, due invoices are collected, periods advance,
dunning climbs, cancellations close. The cron fires it, the worker runs it and the operator's
"jetzt abrechnen" calls the same function. **Nothing in it is safe because it runs once a day.**
Every step claims a row under a unique index before it acts — `subscription_invoice
(subscription_id, period_start, kind)`, `invoice_collection (invoice_id, offset_days)`,
`dunning_action (invoice_id, level)` — inside a transaction that already holds the subscription
or the invoice `FOR UPDATE`. `billing_run (run_day)` is the cheap layer on top: it keeps a second
cron pass off the database and is the only one of the four a human may deliberately bypass.

One status change, one function: `transitionSubscriptionIn()` in
`src/server/subscriptions/service.ts`. The state machine is `src/server/subscriptions/state.ts`
and is pure — `trialing → active → past_due → (active | paused | cancelled) → ended`, with an
illegal move throwing rather than being written. The **services follow** there and nowhere
else, which is why `past_due` deliberately leaves a service running: the grace between the due
date and the suspension rung is what dunning *is*. `cancelled` means *will not renew*, so
dunning never relabels a cancelled Abo `past_due` — it still chases, suspends and ends it.

One plan change, one number: `previewChange()` in `src/server/subscriptions/changes.ts`.
`GET /api/v1/subscriptions/{id}/preview-change` shows what it returns and
`POST …/change` books what it returned; the split over the remaining days is
`calculateProration()`, pure and tested in cents. `differenceCents` is positive when the
customer owes and negative when we do — an upgrade invoices it, a downgrade credits the **same
number** to the account. There is no second rule for the way back, and `reversals.ts` keeps the
rest of them: a renewal taken back is a Rechnungskorrektur *plus* the coupon period given back
*plus* the period rolled to where it was by `precedingPeriod`, the exact inverse of the
`followingPeriod` that moved it forward.

A renewal is priced by `calculateQuote()` like everything else, fed the subscription item's own
**snapshot** — a running Abo is not repriced by a catalog that has moved on. A price reaches a
customer by way of a plan change they agreed to, and by no other route.

Rule: pages, server actions and API route handlers are thin. Business logic lives in
`src/server/**` as plain, testable TypeScript that takes a `db`/transaction as a parameter.
Server actions and `/api/v1` routes call the **same** service functions.

## Hard rules

1. **ULIDs everywhere.** Every table's PK is a prefixed ULID (`text`), generated app-side by
   `ulidPk(prefix)` from `src/db/schema/_columns.ts`; FKs use `ulidFk()`. No serial/identity, no
   UUIDs. The ULID is the cursor for pagination (`WHERE id > $cursor ORDER BY id`).
   Exception: **legal document numbers** (invoice, credit note) are separate gapless sequences —
   the ULID stays the technical ID.
2. **Money is integer minor units (cents)**, stored as `integer`/`bigint`. Never floats. All
   arithmetic, rounding (half-up per line) and formatting goes through `src/lib/money.ts`. Every
   amount has a `currency` next to it or on its parent. A figure that arrives from somebody
   else's API as a decimal string — PayPal sends `"19.99"` — is parsed by `fromDecimalString()`
   and never by `Number(x) * 100`, which for that very value is 1998.9999999999998.
3. **Finalized invoices are immutable.** Corrections only via a Rechnungskorrektur (credit
   note), which has its own gapless range and copies the invoice's tax snapshot rather than
   re-determining it. Invoice numbers are gapless and sequential, assigned at finalization
   inside a transaction (`document_counter` + `SELECT … FOR UPDATE`). Drafts have no number.
   Enforced in `src/server/billing/invoices` **and** by Postgres triggers (migrations `0017`,
   `0018`, `0020`): only `status`, `paid_at`, `cancelled_at`, `sent_at`, `credited_cents`,
   `paid_cents`, `updated_at` and the PDF reference — once, from nothing to something — may
   change afterwards, a finalized invoice cannot be deleted, cannot go back to `draft`, and its
   positions cannot be written at all. A column added later is immutable by default, because
   the trigger compares the whole row minus that list — so letting a new one through means
   naming it in a migration of its own, as `paid_cents` is.
   An invoice's status is `draft → unpaid → (partial) → paid`, plus `cancelled` when a
   correction takes all of it back. **`partial` is an open invoice**: every check that means
   "this still wants money" asks `isOpenInvoice()` / `OPEN_INVOICE_STATUSES`, never a literal —
   including "may this period roll over" and "is this Abo paid up".
   A consequence worth stating: a **Mahngebühr cannot be a line on the invoice it belongs to**.
   It is its own small invoice, and withdrawing it is a Rechnungskorrektur against *that*
   document — the mirror of raising it, through the same machinery.
4. **All multi-step writes run in a DB transaction.** Settling a payment is the shortest one
   worth reading: `applyPayment` takes the payment row `FOR UPDATE` on the provider's unique
   reference *first*, then the invoice, then sums the movements from the rows rather than
   incrementing a column — so a webhook delivered twice, a retried capture and a double-clicked
   button all queue behind the first and find it done. The checkout is the longest of them:
   `placeOrder()` in `src/server/orders/service.ts` writes the order, one subscription per
   billing rhythm, a service per provisionable unit and the finalized first invoice together or
   not at all. It reprices every line from the catalog *inside* that transaction — nothing the
   browser sent is ever a price — takes the cart row `FOR UPDATE` so a double submit produces
   one order rather than two, and redeems a coupon with a conditional
   `UPDATE … WHERE redemptions < max_redemptions`. The invoice is built by
   `createInvoiceDraftIn` / `finalizeInvoiceIn`, the invoicing engine's own functions with the
   transaction handed in: there is no second finalization path and never will be.
5. **Authorization on every query.** Three guards, and nothing else is allowed to decide:
   - `getCurrentCustomer()` (`src/server/customers/current.ts`) is the only way client-area code
     learns which rows it may touch. No page under `(client)` takes a customer id from the
     request.
   - `requirePermission("billing.write")` guards pages and server actions under `(admin)`;
     `assertStaffPermission()` is its throwing form for services. The permission catalogue is
     `src/server/auth/permissions.ts` — a string that is not in it is a type error.
   - `authenticate(request, permission)` guards `/api/v1`. A key is never more than its owner: a
     customer key sees that customer, a staff key sees what its owner's roles grant *today*.

   A caller who may not see a row is told 404, never 403 — 403 confirms the id exists.

   A guest at the checkout has no customer yet, so a fourth identity exists and only there: a
   **cart** is named by a 32-byte secret in an httpOnly cookie, stored hashed (`hashToken`,
   as an API key is). The cart's ULID is not a credential and never appears in a request. On
   sign-in the cart is claimed or merged; a cart that already belongs to another account is
   left alone, so a shared browser cannot carry one customer's basket into another's.
6. **Secrets at rest are encrypted** (AES-256-GCM, key from `APP_ENCRYPTION_KEY`): server API
   tokens, gateway credentials, Graph secrets, service passwords. Use `src/lib/crypto.ts`.
7. **Webhooks and jobs are idempotent.** The event id is *claimed*, not merely looked up:
   `claimEvent()` inserts, or takes the row back if nobody has finished it, and `handled_at` is
   set only by a handler that ran to the end — otherwise a handler that failed halfway would
   make the provider's retry a silent 200. The dedupe row keeps the common case off the
   database; `applyPayment`'s row lock is what actually prevents double settlement.
   A webhook route is unauthenticated by nature, so **its signature check is its
   authorization**, and nothing in a payload may name the invoice it settles: every path finds
   an attempt we recorded under a reference we generated.
8. **Audit log** every state change on customers, subscriptions, services, invoices, payments,
   tickets and settings (actor, action, entity, before/after, IP).
9. **Timestamps** are `timestamptz` in UTC; display in `Europe/Berlin`.
10. **Soft-delete** customers and products (`deleted_at`); never hard-delete anything an invoice
    points at.
11. **Every `/api/v1` endpoint is documented**: registered in the OpenAPI registry with summary,
    description, tags, request/response zod schemas carrying `.meta({ description, example })`,
    error responses and its auth requirement. An endpoint without docs is not done.
12. **No new dependencies without saying why.**
13. **German is the product language.** User-facing copy, invoice wording and legal texts are
    German; code, comments and commit messages are English.

## Tax (pluggable, Kleinunternehmer now)

- `src/server/tax` exposes `interface TaxStrategy { id; determine(ctx); invoiceNotes(ctx) }`.
  A strategy is pure: it reads only the context it is handed and never the database, the clock
  or the settings. `src/server/tax/mode.ts` resolves which one is in force, by date.
- The active strategy comes from settings with an **effective date** (history table), so switching
  to regular VAT applies to invoices finalized from that date on, never retroactively.
- `kleinunternehmer` (active): 0 % on all lines, category `E`, invoice note
  "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet." No tax column on the PDF.
- `regular-vat` (implemented and tested, but disabled): DE 19 %, EU B2B with a VIES-validated VAT
  ID → reverse charge, EU B2C → OSS destination rate, non-EU → not taxable in DE.
- Every invoice line snapshots `tax_strategy`, `tax_rate_bp` (basis points — an integer rate
  cannot pick up a float's error), `tax_category` (UNTDID 5305) and `tax_rule`. Never a live
  lookup. A credit note copies them from the invoice line it credits.
- **The tax amount is per rate, on the sum of the lines at that rate** — not per line and then
  added up. § 14 Abs. 4 Nr. 8 UStG and EN 16931 BR-CO-17 both want it that way, and summing
  per-line roundings can land a cent away from it. The *net* of a line is still rounded once,
  per line (rule 2). Lines therefore carry no tax amount at all.
- Invoices carry all applicable § 14 UStG fields and the operator's Steuernummer.
- **Threshold monitor:** track net revenue per calendar year against the § 19 limits
  (configurable, currently 25 000 € previous year / 100 000 € current year) and warn in the admin
  dashboard at 80 %.

## Commands

```
npm run dev                             # web app
npm run db:up | db:generate | db:migrate | db:reset
npm run test | test:watch               # Vitest
npm run lint | format | typecheck
npm run worker                          # pg-boss + the daily billing:run; its own process
npm run openapi:generate                # writes public/openapi.json (also served live)
npm run seed -- "Name" mail@example.net # Super Admin role + employee + 3 demo customers
npm run staff:add -- "Name" mail@…      # the first employee, when there is none to invite from
```

`npm run test` covers both suites. `tests/unit` is pure; `tests/integration` creates, migrates
and drops its own database on the server `npm run db:up` starts, and skips with a loud warning
when none is reachable.

## Workflow for Claude

- Before a non-trivial change: read the relevant `src/db/schema/*` and `src/server/*`, propose a
  plan.
- After a change: `npm run typecheck`, `npm run lint`, `npm run test`. Fix before declaring done.
- Billing, tax, proration, subscription and dunning logic **must** have unit tests with concrete
  numbers.
- Generate a migration for every schema change; never edit an applied migration.
- Keep this file and `docs/PROGRESS.md` up to date.
- Legal texts (AGB, Widerrufsbelehrung) derive from the LaTeX hosting contracts in
  `~/Developer/tex`, which stay the authority. Do not reword them here on your own.
