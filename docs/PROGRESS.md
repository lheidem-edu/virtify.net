# Progress

State of the conversion described in `docs/BUILD_PLAN.md`. Phases are that file's
numbering. "Existing" means the portal already had it before the conversion started and it
still has to be reviewed against the phase's requirements, not that the phase is finished.

## Phase 0 — Scaffold · done

`npm run typecheck`, `npm run lint` and `npm run test` (68 tests) are green, the app builds,
and the container image runs.

- [x] `CLAUDE.md` with the project brief and the recorded deviations from the original plan
- [x] `docs/BUILD_PLAN.md`, `docs/PROGRESS.md`
- [x] `src/lib/ulid.ts` — monotonic factory, `isUlid()`, prefixed `createId()`, `zUlid`, `zId()`
- [x] `src/lib/money.ts` — integer cents: `add`, `subtract`, `multiply`, `percent`, `allocate`
      (largest remainder), `split`, `prorate`, `format`, `toDecimalString`, `parseAmount`
- [x] `src/lib/crypto.ts` — AES-256-GCM, versioned ciphertext, key fingerprint, keyring with
      rotation, AAD context binding, `hashToken`/`tokenMatches` for API keys
- [x] `src/lib/env.ts` + `src/instrumentation.ts` — zod-validated environment, checked once at
      server boot; `.env.example` documents `APP_ENCRYPTION_KEY`
- [x] Vitest (`vitest.config.mts`, `npm run test`), 53 unit tests over the four modules
- [x] `npm run typecheck` / `format` scripts

- [x] Route restructure: `(site)` → `(marketing)`, `account` → `(client)/client`,
      `admin` → `(admin)/admin`. `/account/**` now answers 308 to `/client/**`, permanently —
      every invoice and offer mail ever sent links to the old path.
- [x] `src/lib/components/*` → `src/components/{shared,client,admin,marketing,legal}`, so no
      React lives under `src/server`
- [x] `src/lib/{documents,payments,legal}` → `src/server/**`; auth, mail and settings →
      `src/server/{auth,mail.ts,settings.ts}`; `src/lib/db` → `src/db`

- [x] `src/server/documents/totals.ts` goes through `money.ts`, so a correction line is the
      exact negation of the line it reverses; covered by tests with concrete cents
- [x] `src/server/payments/config.ts` reads the validated `env`, lazily, so `next build` still
      runs without secrets
- [x] `src/db/schema.ts` split into one file per domain plus `_columns.ts` — `ulidPk()`,
      `ulidFk()`, `money()`, `timestamps()` — applied to all 25 tables. `drizzle-kit generate`
      reports no schema change, so nothing on disk moved.

- [x] `src/server/openapi`: registry, RFC 9457 problem schema, cursor-pagination envelope and
      query, the API-key security scheme, a German/English intro, `GET /api/v1/openapi.json`,
      Scalar at `/api/docs`, `npm run openapi:generate` → `public/openapi.json`. The first
      documented endpoint is `GET /api/v1/health`. Tests enforce rule 11 — every operation needs
      a summary, a description, a tag, a success and a 401, and every schema field a description
      — and pin `public/openapi.json` to the live document so it cannot go stale.

- [x] Dockerfile: multi-stage, `output: "standalone"`, migrations before the server binds, a
      health check against `/api/v1/health`, runs as `node`. Verified by building the image and
      running it against the dev database — 326 MB, migrations applied, `/`, `/terms`,
      `/client/login` and `/api/docs` all served, Docker reporting it healthy.
      `outputFileTracingIncludes` carries the PDF fonts and the legal defaults, which are read
      from the working directory at runtime and would otherwise be missing from the image.

Still open in this phase:

- [ ] Worker entrypoint. Deliberately not a stub: there are no jobs until pg-boss lands in
      Phase 6, and a container that starts and does nothing is worse than one that is absent.
- [ ] Playwright (plan defers the e2e suite itself to Phase 11)

## Phase 1 — Auth, RBAC, customers · done

`npm run typecheck`, `npm run lint` and `npm run test` (123 tests) are green, the app builds,
and `/api/v1/customers` answers correctly against the dev database.

**The customer is no longer the login.** Until now one `user` row *was* one customer: the
password and the master data sat on the same row, so a company could have exactly one person
able to see its invoices. Migration `0014` splits them.

- [x] `customer` — the billing account: customer number, `kind` (Firma | Privatperson), name,
      company, address, country, `vat_id` + `vat_id_validated_at`, phone, Käuferreferenz,
      currency, language, status (active | suspended | closed), internal notes, the Stripe and
      PayPal identities, `deleted_at` for rule 10.
- [x] `customer_contact` — which login may act for which account, with `role` (owner | contact)
      and the three sub-permissions (billing, technical, tickets) plus the address Phase 7 will
      match incoming mail against. One login can hold several; the owner wins.
- [x] `contract`, `offer`, `invoice`, `payment`, `payment_method` and `payment_setup` point at
      `customer_id`. `user` keeps only name, address, password and 2FA.
- [x] Migration `0014` backfills in one transaction: one customer and one owner contact per
      existing login, new ids derived from the login's ULID so the mapping is a substring;
      accounts without a customer number get one counted on from the highest in use; the
      sign-up counter is moved past it. Verified against the dev database — 8 invoices,
      2 contracts, 1 offer and 2 payment methods re-addressed, nothing orphaned.
- [x] `getCurrentCustomer()` (`src/server/customers/current.ts`) is the only way client-area
      code learns which rows it may touch, and no page in `(client)` takes a customer id from
      the request any more.
- [x] The document loaders take the executor as an argument instead of reaching for the pool,
      which is what CLAUDE.md asks for and what makes them testable.

**Staff RBAC.**

- [x] `staff_role` (name, `text[]` of permission strings, `is_system`) + `staff_role_assignment`.
      The catalogue of what may be granted is TypeScript (`src/server/auth/permissions.ts`), so
      a typo is a type error rather than a check that silently never passes.
- [x] `hasPermission()` accepts the permission itself, `domain.*` and `*`.
      `assertStaffPermission()` throws for services; `requirePermission()` redirects to
      `/admin/denied` for pages and server actions. Every page and action under
      `/admin/{customers,contracts,offers,invoices,legal,settings,staff}` now names what it needs.
- [x] "Super Admin" is seeded by the migration with `*` and given to every employee that
      already existed — anything else would have locked the operator out of their own
      installation the moment the migration ran. It cannot be narrowed or deleted, and the last
      holder cannot be stripped of it.
- [x] `/admin/roles`: create roles, tick permissions, assign them to employees.

**Audit log.** `audit_log` + `audit(tx, entry)`, written inside the transaction it describes,
recording only the fields that changed. Wired into customer create/update, API-key create and
revoke, and every role change. The customer detail page shows the trail.

**API keys.** `api_key`, hashed with `hashToken()`, `vfy_` plus eight characters kept in clear
so a key can be recognised. A database check constraint enforces exactly one owner. Create and
revoke in `/admin/api-keys` and `/client/api-keys`; shown once. A staff key is bounded twice —
by its scopes and by what its owner's roles grant *today*, so taking a role away shrinks the
key with it. A customer key can never carry more than `CUSTOMER_SCOPES`.

**First documented endpoints.** `GET`/`POST /api/v1/customers` and
`GET`/`PATCH /api/v1/customers/{id}`, registered under `src/server/openapi/paths/customers.ts`,
with the `Kunden` tag. A key that may not see a row is told 404, not 403 — 403 would confirm
the id exists.

**Client area.** Registration asks Firma or Privatperson, country and an optional USt-IdNr. and
runs server-side, so the login and the billing account are created together; the profile edits
the customer through the same service and the same audit entry the admin form uses.

**Seed.** `npm run seed -- "Name" address@example.net` — Super Admin role, one employee holding
it, three demo customers. Idempotent, and it refuses to add demo data to a database that
already has customers.

**Tests (55 new).** `tests/integration/` runs against a throwaway database it creates, migrates
and drops per run; with no server reachable the suite skips with a loud warning rather than
failing on a machine without Docker.

- scoping: a customer's loaders return their own rows only; loading another account's invoice,
  offer or contract by id returns null; an employee sees both; cursor pagination neither repeats
  nor skips; a soft-deleted account is invisible; an unchanged save writes no audit row.
- permissions: wildcards, domain wildcards, near-miss prefixes, a role being narrowed, the
  Super Admin guards.
- API keys: a staff key narrowed to its owner's roles, a customer key to its own account, a
  revoked key, an expired key, one customer revoking another's key, the one-owner constraint.
- the four endpoints end to end through the real handlers: 401 without a key, 403 for a scope
  the owner lacks, 404 for another account, 422 with the field named, and `status`/`notes`
  ignored on a customer key.

Decided in this phase, open to being overruled:

- **No Next.js middleware for `/admin/**` and `/client/**`.** The plan asks for one; the layouts
  and `requireStaff()` / `getCurrentCustomer()` already refuse server-side on every request,
  against the database. A middleware could only check that a cookie is present, which is a
  weaker gate in front of a stronger one.
- **One account per login, for now.** `customer_contact` allows several and the resolver prefers
  the owner, but there is no account switcher — that waits for Phase 9. Nothing creates a second
  contact yet.
- **`npm run lint` walked `.next`** and crashed Biome with a stack overflow whenever a build had
  been run. `biome.json` now excludes the build output; the gate runs again.
- **The admin sidebar still shows every link.** Hiding one is a convenience, never the access
  control, and `/admin/denied` says which permission is missing. Filtering the nav by permission
  is cosmetic and was left out.

Still open in this phase:

- [ ] Contacts are read-only in the admin area: the table and the sub-permissions exist, but
      there is no UI to invite a second login onto an account or to change what it may do.
- [ ] Existing accounts carry `Deutschland` rather than `DE` in `country`. Phase 3's tax
      determination needs ISO codes; new input is validated and upper-cased, the two rows on the
      dev database are not.

## Phase 2 — Product catalog · done

`npm run typecheck`, `npm run lint` and `npm run test` (178 tests) are green, the app builds,
`public/openapi.json` is regenerated, and the storefront and admin area were clicked through
against the dev database.

**One price function, and only one.** `calculateQuote()` in `src/server/billing/pricing.ts` is
pure — product, cycle, currency, chosen options, quantity, coupon in; a line breakdown and the
totals out, every cent through `src/lib/money.ts`. `quoteProduct()` in
`src/server/billing/quote.ts` is the database half: it loads the rows, refuses a cycle that is
not offered, an option that is not this product's, a value that is not that option's and a
quantity outside the bounds, then calls the pure function. The storefront's live price, the
quote endpoint and Phase 4's checkout all come through that one pair; nothing recomputes a
total in the browser.

- [x] `src/db/schema/catalog.ts` — `product_group`, `product`, `product_pricing`,
      `config_option`, `config_option_value`, `config_option_pricing`, `coupon`; migration
      `0015`. Prices are a matrix of product × cycle × currency, and a missing cell is what
      "not offered" means.
- [x] `product.module` + `module_config` jsonb, validated against the zod schema the module
      publishes. `src/server/provisioning` holds the registry and the one module there is,
      `none`, whose schema is `strictObject({})` — so switching a product back to `none` cannot
      leave another module's settings behind. The lifecycle methods (`create`, `suspend`, …)
      are deliberately absent until Phase 8, which is the first phase with anything to run them
      against.
- [x] Product type `subscription`: a pure recurring product that never reaches a module —
      support plans, managed services, licences.
- [x] Admin under `/admin/catalog`: groups with up/down reordering, products with the pricing
      matrix (cycles × currencies, setup fee, trial days), configuration options with their
      values and per-cycle surcharges, and `/admin/catalog/coupons`. New permissions
      `catalog.read` / `catalog.write`.
- [x] Storefront: `/products` lists the groups and their products with the lowest price,
      `/products/<slug>` is the product page with a cycle selector, the options and a coupon
      field. Every total on it is fetched from the shared function through a server action.
- [x] API: `GET /api/v1/products`, `GET /api/v1/products/{id}` (id or slug),
      `POST /api/v1/products/{id}/quote`, registered under `src/server/openapi/paths/products.ts`
      with the `Katalog` tag. Drafts and retired products are 404, not 403. `catalog.read` is in
      `CUSTOMER_SCOPES` — the catalog is what a customer orders from.
- [x] Every catalog write runs in a transaction and leaves an `audit()` row inside it.
      Products are soft-deleted (`deleted_at` + status `retired`); a group can only be removed
      while it is empty, and a coupon that has been redeemed can be switched off but not
      deleted.

**Tests (55 new).** `tests/unit/pricing.test.ts` states every number in cents: base price per
cycle, options multiplied by their own quantity and the product's, the setup fee charged once
and never again, trial days deferring the period but not the setup fee, and coupons as `once`,
`repeating(n)` and `forever` — including the rounding table (15 % of 19,99 € → 3,00 €, 50 % →
10,00 €, 33,33 % of 10,00 € → 3,33 €) and a fixed coupon worth more than the order, which
discounts to zero rather than paying out. `tests/integration/catalog.test.ts` covers the unique
indexes, the module-config refusal, the soft delete, the audit rows and the reordering;
`tests/integration/products-api.test.ts` drives the three endpoints through the real handlers.

Decided in this phase, open to being overruled:

- **The setup fee is charged on day one, trial or not.** The work of setting a service up
  happens whether or not the first month is free, and that is what WHMCS and Blesta do. A
  coupon can still reduce it — see the next point.
- **A coupon leaves the setup fee alone unless it says so.** `coupon.applies_to_setup_fee` is a
  per-coupon switch, off by default: a discount on the Einrichtungsgebühr is a different
  decision from one on the running price, and most codes mean the latter.
- **A percentage coupon is stored as basis points** (`2500` = 25 %), so the rate itself is an
  integer and cannot pick up a float's rounding error on the way to a price. The discount is
  rounded half away from zero to whole cents by `money.basisPoints`, which is the same rule the
  invoice lines use.
- **`renewal_cents` is the undiscounted period**, except for a `forever` coupon where it is the
  discounted one. `discount_periods` says how long the first price holds: `1`, `n`, or `null`
  for "every period". That is what the storefront needs to write "19,99 €/Monat, danach
  24,99 €".
- **The catalog offers one currency.** `CATALOG_CURRENCIES` is `["EUR"]` because
  `src/lib/money.ts` knows the minor units of exactly one; the matrix is already keyed by
  currency, so adding a second is teaching `money.ts` its exponent, not widening a list.
- **A product group is hard-deleted, and only while it is empty.** Nothing but a product points
  at one, so there is no document to orphan — unlike a product, which an invoice line will
  reference for as long as the books are kept.
- **Config options belong to one product.** WHMCS shares option groups across products; here an
  option is the product's own. Sharing can be added when a second product wants the same
  add-on, and guessing at it now would be a join table nothing uses.
- **`module_config` is not on the wire.** It is the operator's configuration of a provisioning
  module — template ids, node names — and says nothing a buyer needs to decide or to order.

Reviewed after the fact, and fixed (commit after `e933445`):

An adversarial review of `e933445` — four independent reviewers over the diff, each finding
refuted by a separate skeptic before it counted — raised 29 candidates, of which 18 survived.
All 18 are fixed. The ones that moved money or lost data:

- **A fixed coupon was worth twice its face value** when `applies_to_setup_fee` was on. It took
  its whole amount off the period *and* its whole amount off the setup fee: a 10,00 € code
  against 20,00 €/Monat + 15,00 € Einrichtung charged 15,00 € instead of 25,00 €, while
  labelling itself "10,00 €" in the same quote. A fixed amount now has one budget across both
  sides and spills onto the setup fee only with what the period could not absorb; a percentage
  still applies its rate to each side, which is what a rate means.
- **`money.percent` rounded a half cent down.** `cents * (rate / 100)` divides twice in binary
  float — `29 / 100` is `0.28999999999999998` — so 29 % of 7,50 € arrived as 217,49999999999997
  and became 2,17 € instead of 2,18 €. 228 of the first half-million whole-percent/amount pairs
  were wrong. `money.basisPoints(cents, rate)` now does one division on an integer numerator,
  and `percent` routes through it. This is Phase 0's code, not Phase 2's, but it is the function
  the VAT layer will call on every invoice line.
- **A soft-deleted product was unreachable, so the deletion was permanent.** `getProduct` and
  `listProducts` both filtered `deleted_at`, and the admin detail page — the only page carrying
  the restore button — called `getProduct` and 404'd. `restoreProduct` could never be invoked,
  and the row went on holding its slug where nobody could see what was holding it. Both take
  `includeDeleted` now, the admin list shows deleted products with a badge, and the detail page
  loads them.
- **Saving an option's values deleted surcharges for cycles the form had not rendered.** The
  form's columns came from the product's *current* pricing, and the save replaces every pricing
  row of every value. Drop the annual price, edit the options, put the annual price back, and
  the annual surcharges were gone silently. The form now also renders every cycle an option
  value already prices.
- **An unreadable surcharge was stored as 0**, wiping the figure the operator was trying to
  correct. The pricing matrix above it already guarded this; the option-value path does now too.
- **Editing a coupon dropped product restrictions the form could not render** — one past the
  hundredth product, or one since deleted. An empty `product_ids` means *every* product, so a
  product-specific coupon quietly became catalog-wide. The form carries the current restriction
  in hidden fields and the action keeps what it did not show.
- **"Gültig bis" was read as midnight UTC**, so a coupon was refused for the whole of the day it
  was meant to cover. Dates are now read in Europe/Berlin — a `validFrom` at the first instant
  of its day, a `validUntil` at the last — because that is the calendar the operator is looking
  at when they pick one.
- **The option-value audit row recorded names only.** A pure price change left `before` and
  `after` identical, on the one field anybody would come back to check. Surcharges are in the
  trail now.
- **An option with `min_quantity` above `max_quantity`** was saveable and made every quote for
  the product throw. Refused at the boundary.

And the smaller ones: the quote endpoint gave a distinct answer for a code that does not exist,
which is an enumeration oracle on an unauthenticated endpoint — every unusable code now gets one
answer (**decided here, open to being overruled:** the operator still sees the real reason in the
admin, the customer does not); "Danach je Zeitraum" showed the undiscounted price directly under
a line saying "für 3 Abrechnungszeiträume", and now reads "Ab dem 4. Zeitraum"; a coupon labelled
itself "10,00 EUR" instead of "10,00 €"; "1 Tage kostenlos"; a pricing-matrix error printed the
raw English cycle enum to a German operator; and a test comment stated the opposite of the
assertion below it.

Six new tests, and the rounding fix was proved non-vacuous by restoring the old `percent` and
watching the new cases fail.

Still open in this phase:

- [ ] Nothing can be ordered yet. The product page prices a configuration and says so; the cart
      and the checkout are Phase 4.
- [ ] `coupon.redemptions` is only ever read. Phase 4 counts it up when an order uses the code,
      which is also where `max_redemptions` starts meaning something.
- [ ] No demo catalog in `npm run seed`. The dev database was given one by hand while this
      phase was being tested; a fresh installation starts with an empty catalog.

## Phases 3–11

| Phase | State | Notes |
|---|---|---|
| 3 Tax + invoicing | existing, partial | Invoices draft → issued → paid → corrected, gapless numbering via `document_counter` with `FOR UPDATE`, DIN 5008 PDF, XRechnung CII, Rechnungskorrektur. Missing: `TaxStrategy` interface (§ 19 is hardcoded in `totals.ts`), `tax_mode_history`, per-line tax snapshots, the immutability trigger, the § 19 threshold monitor, PDF storage behind an interface, GiroCode. |
| 4 Cart, checkout, orders | not started | `contract` and `offer` exist and are created by hand in the admin area; there is no cart, no self-service order. |
| 5 Payments | existing, partial | Stripe + PayPal, stored payment methods, off-session collection, webhooks with dedupe, settlement in one transaction. Missing: the `PaymentGateway` interface the plan asks for, bank transfer as a gateway, partial payments, overpayment → credit ledger, refunds, disputes, gateway credentials in encrypted settings. |
| 6 Subscriptions, dunning | not started | No pg-boss, no renewal run, no dunning, no proration. `contract` carries the term arithmetic (`src/lib/documents/contract-term.ts`) but nothing bills it automatically. |
| 7 Ticketing (M365 Graph) | not started | Mail goes out over SMTP via nodemailer. |
| 8 Provisioning (Proxmox) | not started | Phase 2 put the registry interface and the `none` module in `src/server/provisioning`; the lifecycle methods and the Proxmox module are this phase's. |
| 9 Client portal polish, i18n | not started | German only, no i18n layer, no `email_templates`. |
| 10 Reports, webhooks, API | not started | |
| 11 Hardening, deploy | not started | |

## Carried over from before the conversion

- **Timestamps are `timestamp`, not `timestamptz`** (58 columns), against hard rule 9. Postgres
  stores them without a zone and node-postgres then reads them as the server's local time, so a
  deployment in another zone would read every date back shifted. Fixing it is one migration that
  rewrites every timestamp column at once, which wants its own change and a look at the data
  first; `timestamps()` in `_columns.ts` deliberately matches what is on disk until then.

- Legal texts are editable in the admin area and stored as versions with an effective date.
  **Bug:** on `/admin/legal` a version published with today's date lands in `inForce`, so it never
  offers "Kunden benachrichtigen". The announce action should be offered for the newest published,
  not-yet-announced version.
- The AGB name the customer area by its address. The built-in wording in
  `src/server/legal/defaults/terms.txt` now says `/client`, but two copies do not:
  **the LaTeX contracts in `~/Developer/tex`, which are the authority, still say `/account`**, and
  so does any version already published in `legal_document`. The old path redirects, so nothing is
  broken meanwhile. `legal/*.txt` at the repo root is export, not source — run `npm run
  legal:export` to refresh it.
- Operational, not code: `STRIPE_WEBHOOK_SECRET` and `PAYPAL_WEBHOOK_ID` need a public URL;
  PayPal reference transactions need PayPal's written approval before
  `PAYPAL_VAULTING_ENABLED=true`; Stripe receipt mails must be turned off; a real outbound SMTP
  relay is still missing; the new AGB § 7 and the Datenschutz sections want reading by the
  operator; a Steuerberater should see a sample invoice before go-live.

## Decisions taken without asking, open to being overruled

- **The image is built with placeholder secrets.** `next build` imports every route to collect
  its data, and the auth routes construct their Better Auth instance and their database pool
  while being imported, so the build cannot run with those variables unset. Nothing connects —
  `pg` opens no socket until the first query — and the real values are checked at boot by
  `src/instrumentation.ts`. The alternative is making the pool and the auth instance lazy, which
  is a wider change than a Dockerfile should carry.

- **npm, not pnpm.** The lockfile is npm's and switching buys nothing.
- **Prefixed ULIDs in `text`, not bare `char(26)`.** They are already in every table and in every
  stored gateway reference. The prefix is constant per table, so ULID cursor pagination still
  works, which was the plan's reason for the rule.
- **The marketing landing page stays at `/`.** The plan's own layout keeps `(marketing)` for the
  storefront, cart and checkout, so the pages become the shop front rather than being deleted.
- **`ulid()` takes no timestamp.** A monotonic generator silently ignores a seed behind the last
  one it saw, so seeding is only available from `ulidFactory()`, which owns its own state.
