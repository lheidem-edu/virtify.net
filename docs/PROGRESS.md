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

## Phase 3 — Tax strategies + invoicing engine · done

`npm run typecheck`, `npm run lint` and `npm run test` (299 tests) are green, the app builds,
`public/openapi.json` is regenerated, and every document and admin page in this phase was
rendered against the dev database and looked at.

**Tax is a strategy, and the strategy is picked by a date.** `src/server/tax` is the
`TaxStrategy` interface CLAUDE.md fixes — `id`, `determine(ctx)`, `invoiceNotes(ctx)` — and
nothing else. A strategy reads only the context it is handed: seller, buyer, the instant, what
is being supplied. No database, no clock, no settings. That is what makes a finalized invoice
reproducible years later from its own snapshot.

- [x] `kleinunternehmer` (active): 0 % on every line, category `E`, the sentence
      "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet." — and **no tax column on the PDF at
      all**. § 19 Abs. 1 Satz 4 UStG forbids showing a tax amount, and § 14c Abs. 2 makes a
      Kleinunternehmer owe one they print whether or not they collected it.
- [x] `regular-vat` (implemented, tested, **not active**): the seller's country at the standard
      rate for a domestic sale; 0 % with category `AE` and the reverse-charge sentence for an EU
      business with a VAT ID that VIES has actually confirmed; the destination country's
      standard rate through OSS for an EU consumer; category `O`, not taxable in Germany,
      outside the EU. An ID nobody has checked is treated as no ID at all — under § 18e UStG the
      seller is the one who owes the tax when it turns out to be wrong.
- [x] `tax_mode_history` + `taxModeAt(executor, at)`. A switch is a row with an effective date,
      not a setting: `/admin/settings/tax` schedules one behind a confirmation dialog **and** a
      tick box, lists what is planned, lets a switch that has not taken effect yet be withdrawn,
      and refuses one dated into the past. Resolution is by the **finalization date**, so
      switching is never retroactive — proved by a test that issues one invoice before the
      switch and one after and reads the first one back unchanged.
- [x] EU standard rates with effective dates live in `src/server/tax/rates.ts`, as code rather
      than a table — see the decisions below.

**The invoicing engine.** `src/server/billing/invoices` is the lifecycle, and it absorbed what
`src/server/documents` had rather than growing beside it: `documents/totals.ts` is gone, the
invoice loaders moved, and `documents/{pdf,xrechnung,send,numbering,repository}.ts` were
rewritten to take the tax snapshot as data.

- [x] `finalizeInvoice()` in one transaction: resolve the strategy in force at that instant,
      apply it to every line, freeze seller and buyer onto the row, compute the totals, and take
      the gapless number from `document_counter` under the row lock its upsert holds. Status
      `unpaid`. The lines are written **before** the invoice leaves `draft`, because the trigger
      refuses them afterwards.
- [x] **Immutability twice over.** The service refuses it, and migration `0017` installs
      Postgres triggers that refuse it again: `invoice` may change only `status`, `paid_at`,
      `cancelled_at`, `sent_at`, `credited_cents`, `updated_at` and the PDF reference once;
      `invoice_item` may not be inserted, updated or deleted while its invoice is finalized;
      `credit_note` is immutable from its first commit and cannot be deleted. The comparison is
      *the whole row minus the mutable columns*, so a column added later is immutable by
      default — the direction a mistake should fall in.
- [x] **Credit notes on their own gapless range** (`RK-{YEAR}-{0000}`), full or partial,
      referencing the invoice they credit. Amounts are stored positive (UNTDID 1001 type 381);
      the tax snapshot is copied from the invoice's own lines and never re-determined, so a
      correction issued after a strategy switch still reverses the rate the invoice charged.
      A partial correction may never take back more than was charged, counting what earlier
      ones already took.
- [x] Every line snapshots `tax_strategy`, `tax_rate_bp` (basis points, so a rate is an
      integer), `tax_category` (UNTDID 5305) and `tax_rule` — *why* that rate — plus its own
      `net_cents` and service period.

**PDF, stored once.** `@react-pdf/renderer`, DIN 5008 Form B as before, now with: the tax
column and the summary grouped by rate (absent entirely under § 19), the § 14 UStG fields, the
operator's Steuernummer *and* USt-IdNr. where both are held, the service period per line where
it differs from the document's, and an **EPC/GiroCode QR** for the bank transfer. The bytes are
written to a document store behind an interface (`src/server/storage`, local disk today, S3 a
module away) and every later request is served from it — a template change cannot restyle a
document the customer already holds. Write-once: the row's `pdf_key` goes from nothing to
something and is then refused by the trigger.

**§ 19 threshold monitor.** `netRevenueForYear()` sums the net of **paid** invoices less what
credit notes took back, attributed to a calendar year by a configurable date (Leistungs-,
Rechnungs- or Zahlungsdatum), read in Europe/Berlin. `/admin` is now a dashboard with the two
limits as bars; staff with `billing.read` get one mail at 80 % and one at 100 %, deduped by a
unique index on (year, metric, level) so a second invoice the same afternoon sends nothing.
Checked where the figure can actually move: after a payment is marked or settles.

**Surfaces.** Admin invoice list and detail (now with the tax summary, the corrections against
the invoice and what is still open), manual invoices, finalize, cancel-by-correction with a
reason, resend, PDF and XRechnung; `/admin/credit-notes` list and detail; `/admin/settings/tax`.
Client invoice list and detail with the corrections underneath, and PDF/XML for both.

**API.** `GET /api/v1/invoices`, `GET /api/v1/invoices/{id}`, `GET /api/v1/invoices/{id}/pdf`,
`POST /api/v1/invoices` (staff only, draft) and `POST /api/v1/invoices/{id}/finalize` (staff
only), registered under `src/server/openapi/paths/invoices.ts` with the `Rechnungen` tag. A
customer key sees its own invoices and never a draft; `customer_id` is ignored for it rather
than honoured. A row it may not see is 404, never 403. Finalizing something that is no longer a
draft is 409, not a silent success.

**Migration `0016` + `0017`.** The status `issued` is called `unpaid` from here on, which is
what docs/BUILD_PLAN.md's lifecycle says. The two corrections that were kept as negative
invoices in the RE- series became credit notes, keeping the RE- numbers they were issued under —
a document the customer holds cannot be renumbered, so the RE- series has two holes that two
credit notes account for, and every number ever handed out is still attributable. Every
finalized invoice was given the § 19 snapshot it was issued under and the totals its lines add
up to. `customer.country` was put into ISO codes, which the tax determination needs; the two
dev rows that said "Deutschland" are `DE` now.

**Tests (105 new, 273 in all).**

- `tests/unit/tax.test.ts` — § 19 charging nothing to anybody anywhere; regular VAT for DE,
  AT-B2B with a validated ID, AT-B2B *without* one (which is B2C, 20 %), AT-B2C and US; the
  rate table across the Estonian and Finnish changes; the refusal to guess without a country;
  country normalisation; the DIN 5008 address block.
- `tests/unit/totals.test.ts` — per-line rounding, the tax computed per rate on the group
  rather than per line, groups kept apart by category at the same rate, the half-cent cases
  (50 ct at 19 % → 10, 7,50 € at 29 % → 2,18 €), a correction as the exact negation, and the
  one cent a partial correction and its remainder cannot both have.
- `tests/unit/giro-code.test.ts` — the eleven EPC lines in order, the amount format, the byte
  limits, and that the payload really is UTF-8.
- `tests/unit/berlin-date.test.ts` — the winter/summer boundaries of a typed date.
- `tests/integration/invoices.test.ts` — finalization and its snapshot; **twenty parallel
  finalizations producing 1..20 with no gap and no duplicate**; the trigger refusing an UPDATE,
  a DELETE, and every write to the positions; the strategy switch by effective date; DE/AT-B2B/
  AT-B2C/US end to end; credit notes full and partial and the over-credit refusal; the threshold
  crossing 80 % and 100 % at exactly the right euro; the document store.
- `tests/integration/invoices-api.test.ts` — the five endpoints through the real handlers:
  401 without a key, scoping, 404 for a foreign row and for a draft on a customer key, cursor
  pagination, 422 naming the field, 403 without `billing.write`, 409 on a second finalize, and
  the PDF coming back byte for byte identical on the second request.

Decided in this phase, open to being overruled:

- **The tax amount is computed per rate on the group, not per line.** CLAUDE.md says "rounding
  half-up per line", and that is what the *net* of a line does. The tax amount does not exist
  per line: § 14 Abs. 4 Nr. 8 UStG asks for "der auf das Entgelt entfallende Steuerbetrag",
  singular, per rate, and EN 16931 BR-CO-17 says the same. Summing per-line roundings can land a
  cent away from that and makes a validator reject the invoice. So lines carry no `tax_cents`
  at all — only their net and the snapshot of the rate that applies to it.
- **The EU rates are a module, not a table.** The build plan says "OSS destination rate from
  tax_rates". A table would ship empty, be filled by hand once and then go stale while the
  invoices it produced looked perfectly ordinary. In code they are versioned, reviewed, covered
  by tests, and a rate change is a one-line commit with a date on it. The admin area prints the
  whole table so the operator can see what would be charged.
- **A credit note's amounts are positive.** UNTDID 1001 type 381 expects it, the heading already
  says the document is a correction, and everything that aggregates money subtracts them at the
  call site rather than relying on a sign.
- **The § 19 strategy ignores the buyer entirely** — country, VAT ID and all. That is what
  CLAUDE.md specifies and it is right for domestic customers. It is a simplification for a
  cross-border B2B service, where § 3a Abs. 2 UStG puts the place of supply abroad even for a
  Kleinunternehmer. Worth a Steuerberater's opinion before the first EU business customer.
- **Regular VAT does not apply the § 3a Abs. 5 Satz 3 Bagatellgrenze.** It is optional, opting
  into OSS from the first euro is allowed, and the alternative makes the rate on one invoice
  depend on the running yearly total of every other one.
- **`/admin` is a dashboard now** instead of a redirect to the customer list, because the § 19
  figure is the one number that must not be noticed too late. An employee without
  `billing.read` still lands on the customer list.
- **The PDF is stored, not re-rendered.** The alternative — rendering on every request — is
  simpler until the template changes, at which point every old invoice silently changes with it.
- **Finalizing does not render the PDF inside the transaction.** Rendering takes a few hundred
  milliseconds and would hold the number counter's lock for all of them, turning a burst of
  renewals into a queue. It is written immediately afterwards and can always be produced again
  from the frozen row, which is why storing is write-once rather than write-never.
- **A finalized invoice is not deletable at all**, not even by an administrator — § 147 AO. The
  trigger refuses it; the way to undo one is a correction.

Found while building, and fixed:

- **The GiroCode encoded umlauts as Latin-1 in production and UTF-8 in tests.**
  `qrcode-generator` exposes its UTF-8 converter only in the CommonJS build, so reaching for it
  worked under tsx and vitest and was `undefined` in a Next bundle — a 500 on every invoice PDF.
  The payload's own bytes are built here now, and a test asserts them directly instead of
  inferring them from a module count.
- **The QR code was drawn on top of the payment paragraph.** `flexGrow` gives a @react-pdf child
  no bound to wrap against; both halves have explicit widths now.
- **The ISO country codes put "DE" on the address block** of every German invoice.
  `formatRecipient` leaves the home country off and writes a foreign one out in German, which is
  what DIN 5008 asks for.
- **A date typed into the tax settings was read as midnight UTC**, an hour or two into the wrong
  day — the same bug Phase 2 fixed for coupons. Phase 2's helper is now `src/lib/berlin-date.ts`
  and both use it.
- **A draft showed no tax column even under regular VAT**, because it carries no snapshot. It
  shows what finalizing it today would charge.
- **An employee without `billing.read` could fetch any invoice PDF.** The document routes are
  the one place both sides meet, and the staff branch checked only that a staff session existed.
  `documentViewer()` takes the permission now and answers 404 without it.

### Reviewed after the fact, and fixed

The phase was reviewed against the diff by seven independent readers, each finding put to two
skeptics told to refute it, and the survivors re-derived by hand — six of them against the
running database. Eighteen candidates, twelve survived, ten distinct defects. All ten are
fixed; the suite went from 273 tests to 299, and the new ones were each run against the old
code first to prove they fail.

- **One UPDATE walked around the immutability triggers.** `status` was in the trigger's
  `mutable` list and every other guard keyed off `status = 'draft'`, so
  `UPDATE invoice SET status='draft'` was accepted on a finalized invoice — and the next
  statement then saw a draft and allowed everything. Reproduced against the dev database:
  RE-2026-0003's amounts, its **invoice number** and its buyer name rewritten, its positions
  deleted, and the row itself deletable but for an unrelated foreign key. That is the hole in
  the gapless RE- series § 14 Abs. 4 Nr. 4 UStG forbids and a record § 147 AO says must be
  kept. Migration `0018` refuses the demotion outright, keys the delete refusal on
  `number IS NOT NULL` as well as the status, and does the same for the positions. Not
  reachable from the app — every status write in `src/server` is a literal — but the trigger's
  own header says it exists for the writers that are not the service layer.
- **An invoice with a deduction line could never be cancelled.** `POST /api/v1/invoices`
  accepts a negative quantity and the OpenAPI description advertises it ("Negativ für eine
  Gutschriftsposition"); the correction then refused that sign with a message about integers,
  and a finalized invoice can be neither edited nor deleted. Proved: RE-2026-0001 over 2 × 10,00 €
  less 1 × 10,00 € finalizes at 10,00 € and "Stornieren" fails for good. A correction now
  mirrors the sign, so the pair cancels to nothing.
- **A correction could credit the same position twice.** The remaining quantity was recomputed
  from a snapshot taken before the loop, so two entries naming one position each saw the whole
  remainder. Proved: a line that charged 10,00 € credited 20,00 €, `credited_cents` 2000, and
  the per-position count 2 for a quantity-1 line. The document-level cap did not notice, because
  a larger line on the same invoice left room under the gross. What is left is now decremented
  as this call's own lines consume it. Latent rather than live — nothing but the tests passes
  `kind: "partial"` today.
- **The e-invoice dated itself in UTC while everything else used Berlin.** BT-2 and BT-9 came
  from `getUTCFullYear()` while the PDF (`src/lib/format.ts`) and the invoice number
  (`berlinYear()`) read the Berlin calendar. An invoice finalized at 00:30 on 1 January is
  numbered RE-2027-0001 and dated 01.01.2027 on paper; its XML said 20261231 — the wrong VAT
  period, in the same mail as the PDF that disagreed.
- **The XML declared XRechnung 3.0 and did not meet it.** It named the CIUS in its guideline
  identifier while omitting BG-16 PAYMENT INSTRUCTIONS (BR-DE-1) and BG-6 SELLER CONTACT
  (BR-DE-2/5/6/7) — the IBAN, the BIC and the telephone number were all on the frozen snapshot
  and printed on the PDF, and none of them reached the XML. Every invoice would have been
  rejected by a recipient that validates. Both groups are emitted now, in the sequence CII
  fixes, with `PaymentReference` carrying the invoice number.
- **A category `O` line carried a VAT rate**, which EN 16931 BR-O-5 forbids: out of scope is not
  a rate of nothing. Only after a switch to `regular-vat`, and only outside the EU, but the
  element is gone for that category now. `E` and `AE` keep theirs, which BR-E-5 and BR-AE-5
  require.
- **XRechnung had no tests at all.** `tests/unit/xrechnung.test.ts` is new: 14 cases over the
  categories, the dates, the mandatory groups and the CII element order. Seven of them fail
  against the code as it was.
- **The document routes did not ask for a second factor.** `documentViewer()` resolved the staff
  side with `getStaffSession()` rather than `requireStaff()`. Route handlers run no layout, so
  an employee who had accepted an invitation, set a password and never enrolled TOTP was
  redirected on every `/admin` page but could still fetch any customer's invoice, correction and
  offer through the `/client/…` URLs the admin UI links to — with the permission, so not an
  escalation, but exactly the bypass the 2FA requirement exists to prevent.
- **`berlinInstant()` was an hour out on the two days the clocks move.** The offset was sampled
  at noon and applied to midnight, so the start of the spring-forward day landed at 23:00 the
  evening before — a tax switch catching the invoices of a day it was not scheduled for, which
  is the failure the module's own docstring names. The offset is resolved at the candidate
  instant now. Only the start was affected; the end of day was always right.
- **`POST /api/v1/invoices` answered with `"items": []`** although the request had to supply at
  least one and a GET on the same id listed them. It reads the draft back now.
- **A customer key asking `?status=draft` got every invoice it had.** The filter was dropped to
  `null` for that case, which removes the predicate rather than narrowing it to nothing. It is
  passed through now and `excludeDrafts` cancels it out.

Still open in this phase:

- [ ] **The § 19 Gesamtumsatz is attributed by the service date.** `revenue_basis` defaults to
      `service` and there is no form to change it — it is only displayed, on the dashboard and
      on `/admin/settings/tax`. § 19 Abs. 2 UStG measures **nach vereinnahmten Entgelten**, which
      is the `payment` basis. The monitor already counts only paid invoices, so the difference is
      which calendar year a payment lands in, and it only bites around the turn of the year.
      Worth a word with the Steuerberater before the next one, and a setting either way.
- [ ] **Partial corrections are implemented and unreachable.** `createCreditNote` takes
      `kind: "partial"` with a line selection, it is tested, and nothing calls it: the admin
      offers only a full Stornierung and there is no credit-note endpoint. Either wire it up or
      say why not.
- [ ] **Nothing renders a PDF in the test suite.** `@react-pdf/renderer` cannot render under
      this vitest configuration at all — the smallest possible document fails inside the
      reconciler before any of our code runs, and the `unicode-properties` alias in
      `vitest.config.mts` fixes only the import. The app itself renders fine. Until that is
      sorted the PDF layer is covered by nothing but the running server, which is how
      `showTax`, the § 14 fields and the GiroCode's placement go unverified. (`include` is also
      `tests/**/*.test.ts`, so a `.tsx` test cannot be collected at all.)
- [ ] **`pdf_sha256` and `pdf_bytes` are written and never read.** The column comment says a
      swap would be detectable; nothing detects one. Either a verification path or an honest
      comment.
- [ ] **No VIES call.** `vat_id_validated_at` is read and respected — an unvalidated ID gets no
      reverse charge — but nothing sets it yet. It wants a service in `src/server/tax` and a
      button on the customer page before regular VAT is switched on.
- [ ] **No S3 storage backend.** The interface is there and the local one implements it; the
      S3-compatible one is a file when a deployment outgrows one node.
- [ ] **Credit notes have no API endpoint.** They are reachable in both areas and as PDF/XML;
      the plan's five endpoints are invoices only.
- [ ] **No XRechnung validation in CI.** "Checked by hand" was not enough — see the two
      conformance defects above, both of which a KoSIT run would have caught the first time.
      `tests/unit/xrechnung.test.ts` now asserts the BR-DE rules the CIUS adds, but asserting a
      rule from memory is not the same as running the validator. It belongs in Phase 11.
- [ ] The operator's Steuernummer is a settings field and is still empty on a fresh
      installation. § 14 Abs. 4 Nr. 2 UStG wants it or the USt-IdNr.; the USt-IdNr. is filled.

## Phase 4 — Cart, checkout, orders · done

`npm run typecheck`, `npm run lint` and `npm run test` (360 tests) are green, the app builds,
`public/openapi.json` is regenerated, and the whole path — product page → cart → guest checkout
→ sign-in → order → invoice → admin decision — was clicked through against the dev database.

**Something can be bought now.** The chain is cart → order → subscription → service → invoice,
and it is written in **one transaction**.

- [x] `cart` + `cart_item`, migration `0019`. **A cart stores a configuration, never a price**:
      which product, which cycle, which options, how many, and a coupon code. Every figure it
      shows is produced by `quoteProductDetail()` at the moment it is shown, so there is no
      stored total to go stale and nothing a browser could have written. A guest cart is
      reachable by exactly one thing — a 32-byte secret in an httpOnly cookie, stored **hashed**
      the way an API key is — so one guest's cookie can never reach another's cart, and the
      row's ULID is not a credential.
- [x] **Merge on sign-in.** `claimCartForCustomer()` runs in a transaction on whatever page is
      rendered next: with no cart of their own the guest cart simply becomes the account's, with
      one the items are moved and the guest cart is closed as `merged` so the move stays
      visible. A cart that belongs to *another* account is never claimed — a shared browser must
      not carry one customer's basket into another's. Idempotent, because the page it runs on
      may be rendered twice.
- [x] `order` + `order_item`, numbered `BS-{YEAR}-{0000}` from the same gapless counter the
      documents use. The order stores what was agreed — per item the catalog cell, the quote's
      totals, the coupon and the full line breakdown — plus the accepted AGB **fassung** with
      its timestamp, the Widerrufsbelehrung and the § 356 Abs. 4 BGB request, the chosen payment
      option, the auto-charge opt-in, and the IP and user agent as evidence.
- [x] `subscription` + `subscription_item` with the price snapshot a renewal will need, and
      `service` rows in `pending` — one per ordered unit, because three VPS are three machines.
      `service.credentials_encrypted` exists for Phase 8 to put secrets in (rule 6); nothing
      writes it yet.
- [x] **The first invoice goes through Phase 3's engine, not beside it.** `finalizeInvoice` was
      split into `finalizeInvoiceIn(tx, …)` and a wrapper, so the checkout hands in its own
      transaction and the tax strategy is still resolved by the finalization date, the snapshot
      still frozen, the number still taken under the counter's row lock. There is no second
      finalization path. The PDF is rendered after the commit, as everywhere else.
- [x] `product.provisioning_mode` (`manual` | `auto_on_payment`), snapshotted onto every service
      so changing a product cannot change an order already placed. `site_setting.billing_anchor_day`
      (0–28) switches billing-day alignment on.
- [x] Storefront: "In den Warenkorb" on the product page, `/cart` (quantity, coupon, remove) and
      `/checkout` with inline sign-in **and** sign-up, the billing address, the three
      confirmations, bank transfer and the auto-charge opt-in.
- [x] `/client/orders` and `/client/orders/{id}` — the page the checkout lands on.
      `/admin/orders` with a status filter, `/admin/orders/{id}` with accept, cancel and mark
      fraud behind `orders.write`.
- [x] API: `POST /api/v1/orders` and `GET /api/v1/orders/{id}` under the `Bestellungen` tag.
      The POST creates and fills a cart **inside the same transaction** that checks it out, so
      the API and the storefront take the identical path and a refused call leaves nothing
      behind. New permissions `orders.read` / `orders.write`, both in `CUSTOMER_SCOPES` — a
      customer key orders for its own account and `customer_id` is ignored for it.

**Tests (61 new, 360 in all).**

- `tests/unit/periods.test.ts` — months added on the Berlin calendar with the day clamped
  (31.01. + 1 = 28.02.), the wall-clock time kept across a DST change, the two clock-change days
  counted as one day each, the anchor as the next occurrence strictly after the instant, and
  proration with concrete cents (1 of 30 days of 19,99 € → 0,67 €; 24 of 365 of 199,90 € →
  13,14 €; exactly half → 10,00 €, rounded away from zero on both signs).
- `tests/unit/order-lines.test.ts` — what a quote puts on the first invoice: the period and the
  setup fee on day one, the quantity kept on the line and multiplied once, a trial contributing
  only its one-off lines, a trial with no setup fee contributing **none**, the discount as its
  own negative line, the fixed coupon's one budget across both sides, proration on the recurring
  lines and only those, and the UN/ECE unit code per cycle. Every case also asserts that the
  lines add up to `dueTodayCents`.
- `tests/integration/orders.test.ts` — the order total **is** the invoice total and the per-item
  figures add up to it; one subscription per rhythm with frozen prices; a service per unit and
  none for a pure `subscription` product; a trial issuing no invoice and burning no invoice
  number; proration against the anchor; a coupon redeemed once per order and refused when used
  up; **two concurrent checkouts of one cart producing exactly one order**; a foreign cart
  refused; the three confirmations; a Firma not being asked for a Widerruf; an incomplete
  billing address refused; the four guest-cart cases; accept/cancel/fraud and their effect on
  the subscriptions and services.
- `tests/integration/orders-api.test.ts` — the two endpoints through the real handlers: 401, 403
  without `orders.write`, a customer key's `customer_id` ignored, a staff key required to name
  one, 422 naming the field, a foreign order 404 and never 403, and the PDF stored after the
  commit.

Decided in this phase, open to being overruled:

- **A coupon belongs to a cart item, not to the cart.** `calculateQuote()` discounts one
  configured product; a cart-level coupon would need a second arithmetic to spread a fixed
  amount over several items, which is the one thing this codebase does not allow itself. One
  order redeems a code once however many lines carry it.
- **A code that was typed in but is not on the quote stops the order.** Both the cart and the
  checkout reprice on every render, so the customer normally watches it fall away — what is left
  is the race, and charging the undiscounted price there would be the panel quietly taking more
  than the screen said a moment earlier.
- **Subscriptions are grouped by rhythm, not merely by cycle:** cycle × currency × trial days ×
  coupon. With no coupon and no trial that is exactly "one subscription per billing cycle", which
  is what the plan asks. The other two parts are rhythm too — a subscription has one
  `trial_ends_at` and one discount counter, so two items whose free days or whose coupon differ
  cannot share one without one of them being billed on the other's schedule.
- **A one-off sale still gets a subscription**, with `next_billing_at` null. It is what owns the
  service and records what was bought; the alternative is a second kind of parent for a service
  and two code paths through the checkout.
- **An order whose first charge is zero issues no invoice at all**, rather than one over 0,00 €.
  The subscription carries the obligation and the first invoice comes when the trial ends.
- **The billing anchor applies to every cycle, annual included**, and there is no minimum length:
  ordering on the 31st with the anchor on the 1st buys one day and is charged for one day.
  Aligning only short cycles would be a rule with no principle behind it, and rolling a stub into
  the next period would charge for a month that was not agreed.
- **Proration is applied to the unit price, not to the line total**, so the line still says how
  many of the thing was bought and its own multiplication still adds up to its net.
- **A consumer is asked for the § 356 Abs. 4 BGB request as well**, because the service starts
  immediately; a Firma is asked for neither that nor the Widerrufsbelehrung (§ 312g i. V. m.
  § 13 BGB) and both columns stay null, with `is_consumer` snapshotted on the order.
- **Accepting an order does not touch its invoice, and neither does marking it fraud.** A
  finalized invoice is cancelled by a Rechnungskorrektur and by nothing else (rule 3), so the
  admin is told to issue one rather than having one issued under a button that says "stornieren".
  Fraud does cancel the subscriptions and terminate the services.
- **The marketing header's cart link carries no count.** Reading the cart cookie there would make
  every page of the storefront — the legal texts included — dynamic for the sake of a badge.
- **A cart is not audited.** Rule 8 lists customers, subscriptions, services, invoices, payments,
  tickets and settings; a basket is none of those. `order.place` and every decision are.

Found while building, and fixed:

- **The inline sign-up at the checkout could not register anybody.** `registerAccount` read
  `company` and `vatId` with `data.get(…)`, which answers `null` for a field the form did not
  render, and an optional zod string does not accept `null` — so a form carrying only name,
  address and password got "expected string, received null" instead of an account. An absent
  optional field is `undefined` now.
- **Two fields on the product form were both labelled "Bereitstellung"** — the new approval mode
  and the provisioning module. The first is "Einrichtung der Leistung" now.

Still open in this phase:

- [ ] **Nothing collects the money.** Bank transfer is the only payment option; the enum already
      has `stripe` and `paypal` and `order.auto_charge` is stored and read by nobody. Phase 5.
- [ ] **Nothing renews a subscription.** The periods, the price snapshots and
      `discount_periods_remaining` are all written for Phase 6, and nothing advances them.
- [ ] **A service never leaves `pending`.** There is no module to run and no queue to run it in;
      `provisioning_mode` is recorded so Phase 8 knows which ones it may take by itself.
- [ ] **Abandoned carts are never swept.** `cart.last_seen_at` is written and nothing reads it.
- [ ] **No `GET /api/v1/orders` list.** The plan asked for two endpoints and that is what is there.
- [ ] The storefront's "Gemäß § 19 UStG …" note is still hard-coded in three places rather than
      coming from the tax strategy. It is right today and wrong the day the switch is thrown.

## Phases 5–11

| Phase | State | Notes |
|---|---|---|
| 5 Payments | existing, partial | Stripe + PayPal, stored payment methods, off-session collection, webhooks with dedupe, settlement in one transaction. Missing: the `PaymentGateway` interface the plan asks for, bank transfer as a gateway, partial payments, overpayment → credit ledger, refunds, disputes, gateway credentials in encrypted settings. Settlement now also runs the § 19 threshold check. |
| 6 Subscriptions, dunning | not started | No pg-boss, no renewal run, no dunning. Phase 4 wrote the `subscription` table, the period arithmetic (`src/server/billing/periods.ts`, with proration) and the price snapshots a renewal needs; nothing advances them. The older `contract` table still exists beside it and is created by hand. |
| 7 Ticketing (M365 Graph) | not started | Mail goes out over SMTP via nodemailer. |
| 8 Provisioning (Proxmox) | not started | Phase 2 put the registry interface and the `none` module in `src/server/provisioning`; Phase 4 added the `service` table, which fills with `pending` rows and never empties. The lifecycle methods and the Proxmox module are this phase's. |
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
  operator; a Steuerberater should see a sample invoice before go-live — Phase 3 makes that
  concrete: `/admin/settings/tax` is where the switch is scheduled, and the sample to show them
  is any PDF from `/admin/invoices`.
- **`timestamp` rather than `timestamptz` now reaches the tax layer.** `tax_mode_history
  .effective_from` and every `issued_at` the resolver compares against are stored in UTC and
  read in Europe/Berlin by `src/lib/berlin-date.ts`, which is correct as long as the column
  really holds UTC. The single migration above is still the fix; nothing here makes it more
  urgent, but it is the first place where getting it wrong would move an invoice's tax rate
  rather than only its displayed date.

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
