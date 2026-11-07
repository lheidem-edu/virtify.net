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
- Payments: **Stripe** + **PayPal** · PDF: `@react-pdf/renderer` · GiroCode: `qrcode-generator`
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
   amount has a `currency` next to it or on its parent.
3. **Finalized invoices are immutable.** Corrections only via a Rechnungskorrektur (credit
   note), which has its own gapless range and copies the invoice's tax snapshot rather than
   re-determining it. Invoice numbers are gapless and sequential, assigned at finalization
   inside a transaction (`document_counter` + `SELECT … FOR UPDATE`). Drafts have no number.
   Enforced in `src/server/billing/invoices` **and** by Postgres triggers (migration `0017`):
   only `status`, `paid_at`, `cancelled_at`, `sent_at`, `credited_cents`, `updated_at` and the
   PDF reference — once, from nothing to something — may change afterwards, a finalized invoice
   cannot be deleted, and its positions cannot be written at all. A column added later is
   immutable by default, because the trigger compares the whole row minus that list.
4. **All multi-step writes run in a DB transaction.** The checkout is the longest of them:
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
7. **Webhooks and jobs are idempotent.** Store provider event IDs and dedupe.
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
