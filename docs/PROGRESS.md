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

`npm run typecheck`, `npm run lint` and `npm run test` (367 tests) are green, the app builds,
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

### Reviewed after the fact, and fixed

Seven readers over the diff, every finding put to two skeptics told to refute it, the survivors
re-derived by hand and the load-bearing ones reproduced against the running app. Nineteen
candidates, fifteen survived, ten distinct defects — five lenses had independently found the
same one. All ten are fixed; 367 tests, up from 360.

- **The cart showed one price and the invoice charged another.** With a billing anchor set,
  proration happened only when the invoice was built: the checkout printed "Heute fällig
  29,99 €", the customer ticked the AGB box against that number, and the finalized invoice said
  25,99 €. That is the one rule this panel is built around — one price, one function — and it
  was broken on every surface at once, which is why five of the seven readers found it.
  Proration now happens **in the quote** (`QuoteInput.firstPeriod`), so the configurator, the
  cart, the checkout, `POST /api/v1/products/{id}/quote` and the invoice are one arithmetic.
  `buildInvoiceLines` no longer prices anything at all.
- **A coupon could drive a finalized invoice below zero.** The discount was computed on a whole
  period while the base lines were prorated afterwards, so a code covering the full period came
  out larger than the stub it was discounting: 10,00 € × 2 with a 20,00 € code on 30 November
  finalized an invoice over **minus one cent**, with a gapless number on it. Computing the
  discount after the proration caps it against what is actually being charged.
- **A trial's first paid period was billed by nobody.** The subscription was written with
  `next_billing_at` a whole cycle *after* the trial ended, while the checkout deliberately puts
  no recurring line on any invoice during a trial. An annual tariff with 14 free days gave away
  14 days and then a year: the order page said "nächste Abrechnung 21.11.2027" directly under a
  cart that had promised the first charge after the free days. The current period is the trial
  now, and the next invoice falls due the day it ends. Phase 6's renewal reads that column.
- **The Leistungszeitraum claimed a day it did not cover.** `BillingPeriod.end` is exclusive —
  the instant the next period begins — and was written unchanged into the line's service period,
  so the PDF and the XRechnung's BG-26 both ran a day past the detail text beside them and
  overlapped the next invoice. § 14 Abs. 4 Nr. 6 UStG wants the period the supply was rendered
  in; the line now ends at the last instant it covers.
- **An order placed on the anchor day was stamped "anteilig für 30 von 30 Tagen"** at the full
  price, on an immutable document. `prorated` compared instants where it had to compare days.
- **An order discounted to exactly 0,00 € still burned an invoice number.** The guard counted
  lines, not cents, and a 100 % coupon leaves a base line and a discount line that cancel. The
  schema's own comment had always said such an order issues no invoice; now it doesn't.
- **`POST /api/v1/orders` answered an unknown `customer_id` with a bare 500.** The cart was
  inserted before anything checked the account existed, so the foreign key fired before the
  service's own sentence about it could. It is a documented 422 problem+json again.
- **The order recorded an AGB fassung the buyer may never have seen.** The checkout resolved it
  while rendering and the submit looked it up *again*, so a version published in between was
  stored as accepted — on the document that is the evidence of the contract. The form carries
  the fassung it printed, and an order whose terms moved underneath it stops and asks again.
- **A line added mid-checkout was silently stranded.** The lock is on the `cart` row and
  Postgres does not extend it to `cart_item`, so a second tab could insert a line that committed
  into a cart about to be closed: the customer was told it was in the basket, the order did not
  contain it, and their next basket was empty. The count is re-read under the lock now.
- **On a phone the total sat below the order button.** The two columns only exist from `lg` up;
  below it the grid collapsed in source order with the summary after the form. § 312j Abs. 2 BGB
  wants the Gesamtpreis "unmittelbar bevor der Verbraucher seine Bestellung abgibt". The summary
  comes first in the DOM and is moved back to the right-hand column by `order`.

Two more came out of the fix itself and were caught in the browser, not by a test: with
proration moved into the quote, "Danach je Zeitraum" and the subscription's own price snapshot
both inherited the *stub's* price — a 19,99 € tariff renewing at 15,99 € for ever. A whole
period is kept beside the short one (`QuoteLine.periodUnitAmountCents`) and is what renews.

One finding was refuted and is recorded here because it is a fair question rather than a bug:
the checkout **requires** a consumer to tick "ich verlange ausdrücklich den sofortigen
Leistungsbeginn". § 356 Abs. 4 BGB frames that as the consumer's choice, so conditioning the
sale on it is a policy decision, not a deviation from the withdrawal regime — the box is
unticked by default, nothing shortens the 14 days, and the § 356 Abs. 4 confirmation that the
right *lapses* is deliberately not collected. Worth a second opinion before go-live.

Still open in this phase:

- [ ] **The Widerrufsbelehrung has no version of its own.** The order stores the AGB document,
      version and label; the Widerrufsbelehrung gets only a timestamp. Both links point at
      `/terms` and one document covers both today, so the AGB version identifies it — but the
      moment they become separate documents that stops being true.
- [x] ~~**Nothing collects the money.**~~ Phase 5. The checkout offers every gateway the
      operator has switched on and hands the buyer straight to it; `auto_charge` is honoured as
      far as Phase 5 can honour it (see below).
- [ ] **Nothing renews a subscription.** The periods, the price snapshots and
      `discount_periods_remaining` are all written for Phase 6, and nothing advances them.
- [ ] **A service never leaves `pending`.** There is no module to run and no queue to run it in;
      `provisioning_mode` is recorded so Phase 8 knows which ones it may take by itself.
- [ ] **Abandoned carts are never swept.** `cart.last_seen_at` is written and nothing reads it.
- [ ] **No `GET /api/v1/orders` list.** The plan asked for two endpoints and that is what is there.
- [ ] The storefront's "Gemäß § 19 UStG …" note is still hard-coded in three places rather than
      coming from the tax strategy. It is right today and wrong the day the switch is thrown.

## Phase 5 — Payments: Stripe + PayPal · done

`npm run typecheck`, `npm run lint` and `npm run test` (445 tests) are green, the app builds,
`public/openapi.json` is regenerated, and the integration proofs run against the real Postgres
`npm run db:up` starts.

**Money moves now, and there is exactly one place where it meets a document.** Everything in
this phase follows from that sentence.

### `applyPayment` — the one path

`src/server/payments/apply.ts`. A Stripe webhook, a PayPal capture, the customer's own return
from a hosted page, a transfer somebody books by hand, credit being spent — all of them end
here, and nothing else may settle an invoice. Two paths is how an invoice gets paid twice by
mechanisms that do not know about each other.

Three things make it safe to run again, and all three are in the database rather than in a
caller's good intentions:

1. The first statement takes the payment row **`FOR UPDATE`**, keyed on the provider's
   reference, which is unique. A second delivery of the same event, a retried capture and a
   double-clicked button all queue behind the first and find it already succeeded.
2. What has been received is **summed from the rows**, never incremented. An increment applied
   twice is simply wrong; a row written twice cannot happen because of (1).
3. The overpayment entry is keyed on the payment by a unique index. Even if everything above
   failed, the customer's balance could not double.

It never recomputes what is owed: `invoice.gross_cents` is what `calculateTotals()` froze at
finalization, `credited_cents` is what the corrections took back, and the arithmetic that turns
those two plus "what arrived" into a status is `settlement.ts` — pure, integer cents, no
database, twenty-two unit tests with the figures written out.

### What is new in the schema — migration `0020`

- **`invoice.status` gained `partial`**, and `invoice.paid_cents` records what actually
  arrived. Both are facts *about* the invoice rather than statements *on* it, so `paid_cents`
  was added to the immutability trigger's short list — named there on purpose, in its own
  migration, because 0017 deliberately made a new column immutable by default. Every check that
  means "this invoice still wants money" goes through `OPEN_INVOICE_STATUSES` / `isOpenInvoice`,
  so adding the status could not leave a half-paid invoice invisible on a list that happened to
  compare against `"unpaid"`.
- **`payment` is the transaction table.** A refund is a **row** (`kind = 'refund'`, pointing at
  the charge it reverses), not a status — so a charge refunded twice in part is two rows that
  add up, and the sum keeps working without knowing anything about refunds except their sign.
  `purpose` tells an invoice payment from a credit top-up, which is the only reason
  `invoice_id` is nullable. Three CHECK constraints state the invariants where every writer has
  to pass.
- **`credit_ledger`** holds the balance as entries, not as a number. A balance column would have
  to be updated by every path that touches it and would be wrong the first time one forgot; a
  ledger is wrong only if a row is missing, and a missing row is visible.
- **`payment_dispute`** — its own table, because a chargeback has a deadline, evidence and an
  outcome weeks later, and one charge can be disputed, won and disputed again.
- **`payment_gateway_setting`** — per-gateway `enabled`, sandbox/live and **one AES-256-GCM
  blob** of credentials (rule 6). One blob rather than a column per secret: the shape of what
  Stripe needs is not the shape of what PayPal needs, and a column is one `select *` away from a
  log line. The environment stays the fallback, so `.env.local` keeps working and a deployment
  can move to the admin area without migrating its secrets.
- **`paypal_plan`** caches the plan ids PayPal insists on for its Subscriptions API. The key
  includes the price, so a price change makes a new plan instead of silently repricing everybody
  already on the old one.

### The gateway interface

`src/server/payments/gateways/types.ts` — `id`, `label`, `capabilities`, `createCheckout`,
`savePaymentMethod`, `chargeSaved`, `refund`, `handleWebhook`. Three implementations:

- **Stripe** — Checkout Session, SetupIntent, off-session PaymentIntent, refunds. The intent is
  created and confirmed in two steps so the id the attempt is recorded under exists *before* any
  money moves. `requires_action` is its own outcome, not a failure: the invoice is still
  collectable, so the customer is **mailed a link** to a fresh hosted checkout and the invoice
  stays open until they use it.
- **PayPal** — Orders v2 with capture; the vault (payment tokens v3) where the account has
  reference transactions, otherwise PayPal's own Subscriptions API. The mode is a setting, and
  the default is the one that works for everybody, because without PayPal's written approval
  every vault charge fails with `MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION` at the worst
  possible moment.
- **`banktransfer`** — a gateway with no API at all, which is the point: `createCheckout`
  returns the bank details and the GiroCode instead of a URL, and the booking still goes through
  `applyPayment`. The alternative is a `markInvoicePaid` that bypasses it, and then a transfer
  and a card payment for one invoice are two mechanisms that do not know about each other.

`credit` is deliberately **not** a gateway: spending a balance is a ledger entry and a payment
row, and the interface would be five methods that all throw.

### Idempotency, which is the whole game here

- **The webhook log is a claim, not a lookup.** Writing the event id and stopping if it is
  already there is wrong in a way that only shows up on a bad day: a handler that fails halfway
  leaves the row, so the provider's *retry* finds the event "delivered", answers 200 and does
  nothing — a payment that failed to settle once then never settles at all. `claimEvent` is one
  statement that inserts *or takes the row back if nobody finished it*, and `handled_at` is set
  only by a handler that ran to the end. Two deliveries racing can therefore both run; that is
  fine, because `applyPayment` is where double settlement is actually prevented.
- **Nothing in a payload may name the invoice it settles.** Every webhook path looks up an
  attempt *we* recorded under a reference *we* generated. PayPal's `custom_id` carries our
  invoice id and is used only to *find* a charge of ours, never to decide what a refund attaches
  to. The one exception is the PayPal subscription mode, where PayPal runs the schedule — and
  there the document is chosen by our own books (the account's oldest open invoice), not by
  anything the payload says.
- **Money crosses the boundary in two places.** `toDecimalString` out, `fromDecimalString` in.
  PayPal speaks decimal strings; `Number("19.99") * 100` is 1998.9999999999998, and `Math.round`
  only hides that until a value lands on the other side of a half. The new parser accepts one
  shape and refuses everything else rather than guessing — deliberately *not* `parseAmount`,
  which reads German and would take `"1.000"` for a thousand euro.
- **An in-flight collection is cancelled, not just marked superseded.** A pending PaymentIntent
  that the row alone had closed would still have completed at Stripe, and the customer would
  have paid twice for one invoice.

### What the operator and the customer get

- Client: payment methods with add / remove / **default**, an invoice page that offers card,
  PayPal, bank transfer with details and GiroCode, and the balance; a **Guthaben** page with a
  ledger and a top-up.
- Admin: `/admin/payments` with every movement in one list, the hand-booking form,
  `/admin/payments/disputes`, and `/admin/settings/payments` for the credentials.
- A refund in the admin area is a **Rechnungskorrektur and then a refund transaction**, in that
  order: a correction without a refund is an operator who still owes money, which is visible; a
  refund without a correction is a document that no longer matches the books, which is not.
- `GET /api/v1/transactions` and `POST /api/v1/invoices/{id}/payments`, both in the OpenAPI
  registry with per-field descriptions, examples and error shapes.

### Decisions taken here, open to being overruled

- **`partial` is a real status**, not a flag. The plan asks for it, and an invoice that is half
  paid should not read "Offen" on a list beside one nobody has touched. The cost is every "open"
  check; they all go through one constant.
- **The § 19 monitor counts a `partial` invoice pro rata.** Counting nothing until it settles in
  full would be the wrong direction for a *monitor*: the limit could be crossed by money already
  in the account, with no warning.
- **A refund of part of an invoice issues no Rechnungskorrektur automatically.** A correction
  credits *positions*, not an amount — EN 16931 and § 14 Abs. 4 want a document that says what
  was taken back. The admin area issues one only when the refund takes back everything the
  invoice still stands for, and otherwise points at the invoice, where the operator picks the
  lines they mean.
- **Money that cannot be placed becomes credit rather than vanishing.** A PayPal-run
  subscription that collects for an account with nothing open, and a payment against an invoice
  that has been corrected away, both land on the balance and the operator is told. It is the one
  outcome that can never be wrong, because the money did arrive.
- **`webhook_event` keeps its name** instead of becoming the plan's `processed_events`.
  Renaming a table to match a word in the plan buys nothing.
- **`markInvoicePaid` in the invoicing service stays, and the admin button no longer uses it.**
  What is left is the books-only statement "nothing is owed on this any more", used by the
  revenue tests; the button books a transfer through `applyPayment` like everything else.

### Reviewed after the fact, and fixed

Eight readers over the diff, every finding put to **three** skeptics with different lenses
(does it reproduce · is it already guarded elsewhere · is the failure story even possible), the
survivors re-derived by hand and the load-bearing ones reproduced against the running app.
Thirty-five candidates, twenty-three survived, **ten distinct defects** — five of the eight
lenses had independently found the same one. All ten are fixed; **470 tests**, up from 446.

- **A refund never touched the credit ledger, so refunded money was paid out twice — or lost.**
  One missing rule with three faces, and the worst defect this project has shipped so far.
  `recordRefund` wrote the refund row, re-settled the invoice and left `credit_ledger` exactly
  as it was. So: a refunded **top-up** put 50 € back on the customer's card and left 50 € of
  spendable balance standing (reproduced, then spent on a fresh invoice, which came out
  `paid`); a refunded **overpayment** did the same with the overshoot; and refunding a payment
  made **from the balance** re-opened the invoice without giving the balance back, so the
  customer owed it again *and* was out the credit. The ledger kind `refund` existed in
  migration `0020` and was written nowhere. The rule now is one sentence — *a refund puts back
  whatever its charge did to the balance* — in `reverseChargeCredit`, and the overshoot is
  `bookOvershootDelta`, the **same function** that grants it, called by `settleAgainstInvoice`
  and `resettleInvoice` alike. Writing it only on the way in was the whole bug.
- **A refund made in the Stripe dashboard was booked nowhere.** `charge.refunded` iterated
  `charge.refunds.data`. That list is not there: since API version `2022-11-15` the Charge
  object no longer auto-expands refunds and an event payload cannot be expanded, so the loop ran
  **zero times**, the route answered 200, `handled_at` was set and Stripe never retried. Stripe's
  own description of the event now says it — *"Listen to `refund.created` for information about
  the refund."* The refund events book it; `charge.refunded` asks the API for the list rather
  than hoping it was sent, so an operator subscribed only to the old event loses nothing either.
- **A lost chargeback never left the books.** `disputes.ts` said the reversal "comes as its own
  event, which `recordReversal` books like any other refund" and no such case existed:
  `charge.dispute.funds_withdrawn` fell through to `default`. The money was gone, the invoice
  still read `paid`, and the § 19 revenue monitor went on counting it.
  `funds_withdrawn`/`funds_reinstated` are handled, the latter back through `applyPayment` under
  a reference we generate.
- **A reversal that could not be booked was dropped in silence.** Both handlers returned
  quietly when `recordRefund` refused — a missing amount, or a chargeback larger than what was
  left of the charge — and the event was marked handled, so the provider never retried and
  nobody was told. That is the one case where the money has already left and our books still
  say it is here: it now raises `notifyUnbookedReversal`. PayPal's amount is also read from both
  shapes it sends (`amount.value` *and* `amount.total`), which was one of the two ways it
  silently became zero.
- **Stripe and PayPal counted as configured without a webhook secret.** `hasWhatItNeeds` asked
  only for an API key, while `/api/webhooks/stripe` answers **503** without the signing secret
  and `/api/webhooks/paypal` without the webhook id. So the checkout offered the card, charged
  it, and had no authoritative path back — dunning then chases a customer who has already paid,
  and an off-session renewal, which has no browser to come back from, is never booked at all.
  Shown live on this machine: with `STRIPE_WEBHOOK_SECRET` empty the invoice page offered
  "25,99 € mit Kreditkarte (Stripe) bezahlen" while `POST /api/webhooks/stripe` answered
  `503 payments are not configured`. The condition is now the one the routes already enforce.
- **Saving one gateway secret blanked the others.** The form promises "gespeichert — leer
  lassen, um ihn zu behalten" per field; the action read them per *gateway*, so rotating the
  Stripe key with the webhook field left blank wrote `{ new key, "" }` and took the webhook down
  with it. The PayPal version blanks the webhook id, which stops `CHECKOUT.ORDER.APPROVED` and
  leaves an approved order uncaptured until PayPal voids it. `mergeCredentials` merges per
  field; `clear` is still the only way to empty them.
- **A partial Rechnungskorrektur left `paid_cents` above what the invoice still asked for.**
  100,00 € paid, a 30,00 € line corrected away, and the document kept `paid_cents` at 10000:
  the schema's own invariant became false and the customer's invoice page printed
  "Offen −30,00 €". `createCreditNote` re-settles in the same transaction now, so the one
  function that decides `status` and `paid_cents` decides them here too.
- **Every ordinary card payment raised the unmatched-money alarm.** A hosted Checkout payment
  arrives twice — as the session, which is the reference the attempt was recorded under, and as
  the PaymentIntent, which is not — and `.env.example` tells the operator to subscribe to both.
  So "Zahlung ohne Zuordnung" fired on every successful payment, which is how the one alarm that
  means *money we cannot book* becomes the one nobody reads. The intent is looked for under the
  capture reference first.
- **A customer's second PayPal top-up was refused, for ever.** The stand-in handed to the
  gateway used `Guthaben {Kundennummer}` as the "number", which PayPal uses as `invoice_id` —
  unique across the whole merchant account, which is exactly why it is used that way for real
  invoices. Every top-up after the first came back `DUPLICATE_INVOICE_ID`. A top-up now carries
  its own reference, and a `descriptor` keeps it out of what the payer reads.
- **`adjustCustomerCredit` and its form were written and rendered nowhere.** The only way to put
  credit back by hand did not exist in the UI — which also meant there was no way to repair the
  balances the defect above was destroying. It is on the customer's **Zahlungen** tab in the
  admin area now, with the balance and the ledger beside it; the tab's copy no longer says the
  payment list "kommt mit Phase 5".

**Four tests were passing without testing anything**, and the review's mutation pass is what
found them. Each is repaired so that removing the thing it names makes it fail:

- The **`FOR UPDATE` row lock** — the central claim of the whole phase — had no test. The
  "two deliveries at once" case never ran its two transactions concurrently: the pool handed the
  first branch its one warm connection while the second was still opening one. Warming the pool
  first makes it a race; removing `.for("update")` now gives `[true, true]`.
- The **customer-key pin on `GET /api/v1/transactions`** was vacuous twice over — it asked for a
  ULID that matched no row, so the loop never ran, and the fixture booked payments on only one
  account. The foreign account has a settled payment now and the page is asserted non-empty;
  removing `scoped ??` makes one customer read another's.
- **`payFromCredit`'s balance check** had no test, and the amount comes straight off a
  customer-submitted form.
- **"counts each payment's own overshoot, not the running total"** used two payments, where the
  delta and the running total are equal by accident. A third separates them: 0, 1001, 2000.

One thing I reported early was **wrong and is corrected here**: I said the client invoice page
had lost the `Math.max(…, 0)` floor on what is owed. It has not — the floor is there, and the
negative "Offen" came only from `paid_cents`, which the re-settle above fixes at the source.

### Reviewed after the fact, and fixed

Eight readers over the phase, three skeptics each, then one isolated worktree per confirmed
defect: a regression test written and watched to fail first, then the fix, then the test broken
again to prove it was not vacuous. Twelve defects, 618 → 660 tests. Every one of them is money
moving while nobody is present, which is what this phase is.

- **A Mahngebühr was itself dunned, so each unpaid fee raised another, for ever.** `runDunning`
  asked for "every open invoice whose `due_at` has passed", and `finalizeInvoiceIn` gives the fee
  invoice a due date a fortnight out — so it matched its own input. Reminder at +3, Mahnung at
  +10, which raised the next fee. The `dunning_action (invoice_id, level)` index cannot stop it:
  every generation is a new invoice id and so a fresh key space. Driven for thirteen months at
  5,00 € a rung against a live database, three reviewers independently produced 27, 29 and 31
  gapless-numbered invoices nobody authorised, and the chains outlived the Abo. Fee invoices are
  now excluded from the ladder by `dunning_action.fee_invoice_id`. A stock install was safe only
  because `dunningFeeCents` defaults to 0.
- **A run that threw blocked that day for ever.** `claimDay` took a day over only when the row
  said `running`, but `runBilling`'s own catch writes `failed` before rethrowing — so all three
  pg-boss retries found the day claimed and did nothing. A process that was *killed* recovered
  after an hour; one that honestly recorded why it died never did. A pass that threw is now
  distinguished from one that finished with per-step failures, and only the first is retried.
- **A pass narrowed to one customer claimed the whole day.** `billing_run (run_day)` speaks for
  the whole night, and only an unscoped pass does. An operator pressing "jetzt abrechnen" for one
  account at 02:00 handed the 03:00 cron a finished row, and every other customer's renewals,
  collections and Mahnstufen were skipped until the next night. A scoped pass now claims
  `day#customer`. **Not found by the review** — it surfaced when two agents' tests, written
  independently, collided on a calendar day.
- **Cancelling to the end of the period left the renewal invoice standing.** The renewal is
  raised a fortnight ahead, and that invoice is precisely what reminds people to cancel. Cancel in
  that window and the Abo ended, the services terminated, and 19,99 € was still collected off the
  card, then reminded, gemahnt and terminated — for a month in which nothing ran.
  `cancelSubscription()` now routes through `cancelRenewalInvoiceIn`, in its own transaction, and
  only for periods that have not begun; on a grouped renewal only the cancelled Abo's positions
  are corrected.
- **A customer could lift their own dunning suspension.** `servicesFollow("active")` woke every
  suspended service unconditionally. `reactivateAfterSettlement` guarded that behind
  `hasOpenInvoice()`; `resumeCancellation` and `resumeSubscription` did not. Press "Kündigen",
  press "Kündigung zurücknehmen", and the server came back with 39,98 € outstanding — and the
  `dunning_action (invoice_id, 'suspend')` row was already claimed, so that rung never fired
  again.
- **And its mirror: a cancelled Abo that paid in full was never woken.** Both reactivation paths
  asked `status === 'past_due'` rather than what is owed, while dunning deliberately leaves a
  cancelled Abo's label alone. The suspension mail promises "Sobald die Zahlung eingegangen ist,
  werden sie automatisch wieder freigeschaltet." For a cancelled Abo that was never true. One
  `wakeSettledIn()` now answers both, on `hasOpenInvoice()`.
- **Pause and resume inside the lead window invoiced the month twice.** Resuming shifts
  `current_period_end`, and a period that has moved is one the renewal run no longer recognises
  as invoiced — the unique index never sees it. Pausing is now refused while a Verlängerung
  stands for the coming period, and says so: take the renewal back, or pause once the new period
  has begun.
- **A period rolled over for free when the renewal step had failed.** `advancePeriods` asked only
  whether an *open* invoice existed, which cannot tell "paid" from "legitimately nothing to pay"
  from "never raised, because step 2 threw". `next_billing_at` then moved past the skipped month
  and it was never billed again. It now needs a positive record that the period was dealt with.
- **Credit spent on a renewal was not returned when the renewal was taken back**, so the next
  pass spent it again and the customer paid one period twice out of their own balance. It goes
  back through `recordRefundIn` — keyed on the charge it undoes, so a repeat is a no-op.
- **The coupon period was given back even when none had been taken.** `consumeDiscountPeriod`
  floors at zero, so a spent coupon consumes nothing and the renewal is at full price; the
  reversal added one back regardless. Taking that renewal back handed the customer a discount
  period they were never promised, permanently. The give-back now asks whether that renewal
  actually consumed one.
- **A plan change agreed for the end of the period was executed when the invoice was raised**,
  terminating a paid, provisioned machine up to `renewalLeadDays` early — and `cancelRenewalInvoice`
  had no inverse for it. The renewal *lines* still carry the new configuration; the item rewrite
  and the service follow wait for `apply_at`.
- **A change during a trial prorated the trial.** A downgrade credited the customer real money
  they had never paid; an upgrade charged them for a period they were being given. Proration now
  divides by the period the whole-period price actually buys, not by the row's own period — which
  also fixes a short first period cut to reach the billing anchor.
- **List paging ran backwards.** `ORDER BY id DESC` with `WHERE id > $cursor`: with five Abos the
  second page repeated the first and the three oldest were unreachable at any page size. Both
  halves now run descending. *Deviation from hard rule 1*, which spells the walk ascending:
  `listSubscriptions` also feeds the admin and client lists, which read newest-first, and what the
  rule is actually about is that the ordering and the cursor comparison point the same way.

Seven tests passed without testing anything and were repaired alongside the defect they sit next
to — among them the cursor test that never followed its cursor, and the +30 terminate rung whose
whole body could be replaced with `continue`. Two more problems were found in the test file
itself: `openInvoicesOf()` returned *every* invoice of a customer, so an assertion that one was
still open held while a cancelled one stood in for it (it is now split into `invoicesOf` and a
truthful `openInvoicesOf`), and a pass skipped because another test had claimed that calendar day
asserted against a world that never moved — `run()` now fails loudly on a skipped pass unless the
case is studying the day marker itself. That guard immediately exposed four more tests running on
passes that had done nothing.

Adjudicated rather than merged: two agents independently gave the cancellation path a way to
return money, with different machinery. What the *balance* paid goes back automatically, keyed on
the charge. What a card or a transfer paid stays as an overpayment on the corrected document and
does **not** become account credit — that is Phase 5's stance (`createCreditNoteIn` resettles
without `causedBy` because no payment row moved), and for somebody who is leaving, a voucher with
the provider they just left is not payment. Which way it goes back is the operator's call, through
`recordRefund`. Taking both would have credited the customer twice.

### Still open in this phase

- [ ] **A cancelled renewal that was already paid leaves an overpayment nobody is told about.**
      The money is on the corrected document and traceable, but attributing it properly still
      wants a `credit_note_id` on `credit_ledger` — the same migration the Phase 5 open item
      asks for.

- [ ] **The overshoot a partial correction creates is not attributed automatically.** After
      `createCreditNote` re-settles, an invoice that was overpaid relative to the corrected
      document shows the difference as received-but-not-owed, and the operator books it with the
      credit form. Minting it automatically needs a key the ledger does not have — the entries
      are unique per `(payment_id, kind)` and a correction has no payment row of its own — so
      attributing it to one of several charges would be guessing. A `credit_note_id` on
      `credit_ledger` would settle it, and that is a migration.
- [ ] **What an invoice still owes is spelled out in seven places.** `settlementFor()` computes
      `outstandingCents` and the pages, actions and API routes each re-derive
      `max(gross − credited, 0) − paid` by hand. They agree today; one of them drifting is
      exactly the shape of Phase 4's shown-versus-charged defect.
- [ ] **`auto_charge` is honoured, but only as far as it can be.** A subscription collects from
      the method the customer stores *afterwards*, in the customer area — the checkout does not
      store a card while taking the first payment. For Stripe that would be
      `setup_future_usage` on the session, which is a small change; for PayPal it needs the
      vault, which needs the approval. Phase 6's renewal run reads `auto_charge` and
      `payment_method_id` and will work the day either is set.
- [ ] **Nothing retries a failed collection.** § 8 of the terms leaves that to the operator and
      they are mailed about it; a dunning run is Phase 6.
- [ ] **A dispute is only recorded, never answered.** The evidence goes in at the provider —
      neither Stripe nor PayPal takes it any other way — so this phase makes sure the deadline is
      not what gets missed.
- [ ] **SEPA Direct Debit is not switched on.** The gateway can do it, but the mandate and the
      Vorabankündigung have to be in § 7 of the terms and the Datenschutzerklärung first, and the
      six-day settlement path only half exists. `payment_method_types` stays `["card"]` until
      then, deliberately.
- [ ] **`POST /api/v1/orders` still only accepts `bank_transfer`.** An order placed through the
      API has no browser to redirect, so naming a gateway there would record a payment option
      nothing could act on.
- [ ] **A credit top-up produces no document.** Money arrives, a ledger entry is written and the
      invoice it later pays is the document. A Steuerberater should look at that before go-live.

## Phase 6 — Subscriptions, recurring billing, dunning · done

`npm run typecheck`, `npm run lint` and `npm run test` (662 tests) are green, the app builds,
`public/openapi.json` is regenerated, and the proofs run against the real Postgres `npm run
db:up` starts.

**This is the first thing in the project that takes money with nobody watching.** A bug here
does not show up as a wrong page; it shows up as a customer charged twice, or a server
suspended for an invoice that was paid. Everything below follows from that.

### The question every table in migration `0021` answers

*A cron fires at three in the morning, a worker is scaled to two replicas, a job times out and
is retried, and an operator presses "jetzt abrechnen" — what makes the customer be invoiced
once, charged once and dunned once?*

Not the caller. Four unique indexes:

| | guarantees |
|---|---|
| `subscription_invoice (subscription_id, period_start, kind)` | one invoice per subscription per period |
| `invoice_collection (invoice_id, offset_days)` | one auto-charge per rung of the retry ladder |
| `dunning_action (invoice_id, level)` | one reminder, one Mahnung, one suspension, one termination |
| `billing_run (run_day)` | one *cron pass* per day — the cheap layer, and the only one of the four a human may deliberately bypass |

Each claim is an `on conflict do nothing` insert taken **inside** a transaction that already
holds the subscription or the invoice row `FOR UPDATE`, and **before** the gateway is called —
a worker that dies between the charge and the bookkeeping must not leave an unclaimed rung
behind for the next pass to charge again.

`subscription_invoice` does a second job: it is what turns "this invoice" into "these Abos" in
one lookup. Dunning needs it to suspend the right service, an off-session collection needs it
to find the right stored card, and the reactivation after a payment needs it to know what to
wake. The checkout writes one too (`kind = 'initial'`), so the very first invoice a customer
ever gets is visible to the recurring machinery.

No column was added to `invoice`. A column added there is immutable by default (migration
`0017`), and nothing in this phase needs to write to a finalized document — which is also why
a **Mahngebühr is its own invoice** rather than a line on the one it belongs to.

### `runBilling()` — the daily pass

`src/server/billing/run.ts`, eight steps in this order and for this reason:

1. **trials end** — a trial that is over is an Abo that bills;
2. **renewals are invoiced**, N days ahead (14 by default, `product.renewal_lead_days` may ask
   for more and the longest in a subscription wins), grouped per customer + currency + billing
   day, credit applied, finalized;
3. **due invoices are collected** off the stored card, d+0 / d+3 / d+7;
4. **periods advance — only where the renewal is no longer open**;
5. **dunning** — reminder at +3, Mahnung at +10, services stop at +14, the Abo ends at +30;
6. **cancellations close** — `cancel_at_period_end`, honoured on the day;
7. **spent coupons are cleared** off the Abo, so the page stops promising a discount that no
   longer applies;
8. **everything that owes nothing comes back** — the mirror of (5).

Each step walks its own list and opens one transaction per customer or per invoice, so one
customer whose card provider is down does not roll back everybody else's renewal. What failed
is counted in `billing_run.report.failures` and shown on the Jobs page; the pass finishes.

The due date of a renewal is the **day the period starts**, not fourteen days after it was
raised — `finalizeInvoiceIn` gained an explicit `dueAt` for it, floored at the issue date so a
pass that runs late cannot produce an invoice that is already overdue. Both ladders are reckoned
from that date.

### What the state machine refuses

`src/server/subscriptions/state.ts` is pure: a pair of statuses in, a verdict out.
`trialing → active → past_due → (active | paused | cancelled) → ended`, and an illegal move
**throws** rather than being written. `transitionSubscriptionIn()` is the only door, so the
services follow in one place and the timeline the customer reads is written in the same
transaction as the change.

Three decisions worth arguing with:

- **`past_due` deliberately leaves a service running.** The grace between the due date and the
  suspension rung is what dunning *is*; suspending on the status would take a server away the
  morning after the due date.
- **`cancelled` means *will not renew*, not *over*.** So it may go back to `active` — that is
  the undo people actually use — and dunning never relabels a cancelled Abo `past_due`. It
  still chases it, still suspends it at +14 and still ends it at +30.
- **Resuming a pause gives back exactly the span that stood still.** `pauseSpanMs` computes it
  once and `shiftInstant` applies it; there is no second arithmetic for the way back.

### One plan change, one number

`previewChange()` computes everything and `applyChange()` books what it returned.
`GET …/preview-change` and `POST …/change` call the same function, which is the point: Phase 4
shipped a checkout that showed 29,99 € and charged 25,99 € because two pieces of code did the
same arithmetic, and here that would be the same defect with the customer's agreement attached
to it.

The split over the remaining days is `calculateProration()` — pure, both sides prorated by one
call over the same days so two roundings cannot drift apart. `differenceCents` is positive when
the customer owes and negative when we do, and `owedByCustomerCents` / `owedToCustomerCents` are
derived from it in one expression: an upgrade invoices the figure, a downgrade credits the
**same figure** to the account. Verified live on this machine — 19,99 € × 1 → × 3 on the 8th of
a 24-day period previewed "Heute 38,31 € anteilig" and produced `RE-2026-0014` over exactly
38,31 €.

A downgrade books **credit, not a Rechnungskorrektur**, and that is deliberate: a correction
credits *positions* of a document (EN 16931, § 14 Abs. 4), and the unused days of a plan are not
a position of the invoice that sold it. Money the customer is owed with no document to hang it
on is exactly what the balance is for, and the next renewal spends it automatically.

### Every rule written in both directions

Phase 5 shipped a refund path that credited the balance on the way in and never debited it on
the way out. `src/server/billing/reversals.ts` is where that lesson is kept:

- a renewal taken back is a Rechnungskorrektur over the whole of it, **plus** the coupon period
  given back, **plus** the billing period rolled to where it was by `precedingPeriod` — which is
  `followingPeriod` read backwards, so the round trip is exact for every cycle;
- a Mahngebühr withdrawn is a Rechnungskorrektur over the fee invoice, and the rung stays
  claimed: the Mahnung *was* sent, and pretending otherwise would let the run send it again.

### pg-boss, and why the worker is its own process

`src/server/jobs`: the queue, the schedule (`billing/run` at 03:00 Europe/Berlin, `missed:
"once"`) and `scripts/worker.mts`. A Next server is scaled by the platform and restarted on
every deploy; a timer inside it would run once per instance and be killed halfway through a
renewal pass by an ordinary redeploy.

The web process holds **no** pg-boss instance at all. "Jetzt abrechnen" calls `runBilling()`
directly in the request so the operator sees what happened, and the Jobs page reads pg-boss's
own tables read-only — which keeps a background library's lifecycle out of a request-scoped
server. Proven end to end on this machine: a job sent to `billing/run` was picked up by the
worker, ran and completed.

Two deliberate concessions to the platform, both load-bearing and both commented where they
bite:

- **the worker does not render PDFs.** `@react-pdf/renderer` reaches a dependency whose subpaths
  publish only an `import` condition, so requiring it from a plain Node process fails outright —
  and forcing the `import` condition globally is what breaks node-postgres (the note in
  `vitest.config.mts` says so). Nothing is lost: `invoicePdf()` renders and stores the document
  on first access, write-once, and the renewal notice links to the invoice rather than attaching
  it. `emitInvoicePaid` imports the receipt mail at the point of use for the same reason — the
  worker has to be able to *collect* money without being able to *draw* a document.
- **the queue is `billing/run`, not `billing:run`.** pg-boss refuses a colon in a queue name.
  The run still signs its audit entries `billing:run`, which is the name a person reading the
  log looks for.

### The API

Eight endpoints, every one in the OpenAPI registry with per-field descriptions, examples and
error shapes (rule 11):

```
GET  /api/v1/subscriptions                      POST /api/v1/subscriptions
GET  /api/v1/subscriptions/{id}
POST /api/v1/subscriptions/{id}/cancel          POST …/pause
POST /api/v1/subscriptions/{id}/resume          POST …/change
GET  /api/v1/subscriptions/{id}/preview-change
```

`POST /api/v1/subscriptions` creates the Abo through `placeOrderFromItems` — the very same
transaction the storefront's checkout runs — rather than writing subscription rows of its own.
An Abo comes into being in exactly one place, with one set of rules about what it costs.

Every action resolves the Abo through the key's own customer id first, so a customer key that
names somebody else's subscription gets **404 on the actions too**, not only on the reads. That
is the half that is easy to forget, and the test enumerates all four.

`subscriptions.read` and `subscriptions.write` were added to `CUSTOMER_SCOPES`: an Abo is the
customer's own contract, and cancelling it or changing the tariff are things the client area
already lets them do with a session. `jobs.read` / `jobs.manage` are staff-only.

### What the operator and the customer get

- Admin: `/admin/subscriptions` with the lifecycle buttons, the Tarifwechsel with its Vorschau,
  the per-position price and billing-date form, every invoice ever raised against the Abo with
  "Verlängerung zurücknehmen", and the timeline.
- Admin: `/admin/jobs` — the billing runs with what each one did, the pg-boss queues, the failed
  jobs, and "der Worker läuft nicht" when no worker has ever started, which is the single most
  useful thing that page can say.
- Client: `/client/subscriptions`, the detail page with the services and their status, the
  Tarifwechsel with "Preis anzeigen" first, and Kündigen / Kündigung zurücknehmen.

### Found by writing the tests, and by driving the real page

Four defects that the writing itself turned up, each now fixed and pinned:

- **A renewal re-charged every add-on's setup fee, every period, for ever.** `calculateQuote`
  takes a setup fee from the product *and* one per chosen add-on; the renewal silenced only the
  first. A VPS with two extra IPv4 at 5,00 € Einrichtung would have carried 10,00 € a month
  under a line reading "Einrichtung" on a recurring invoice. Caught by the second assertion of a
  unit test, not by review.
- **Dunning died silently on every cancelled Abo.** `cancelled → past_due` is not a legal move,
  and dunning attempted it anyway — which threw inside the rung's transaction, so the
  `dunning_action` row was rolled back with it. The customer was never chased for their last
  invoice, the services were never suspended, and the run reported the same failure every night
  for ever. Found by making *every* pass in the test file assert `report.failures` is empty.
- **The first paid period after a trial lost the billing anchor, and a short renewal was not
  prorated.** The checkout anchors the first period; the renewal used a whole cycle from the
  trial's end, so the invoice billed sixteen days while the subscription moved on by thirty, and
  the line said "anteilig" at the full price. `periodAfter()` is now the one function both the
  invoicing and the advance use, and the period goes into `calculateQuote` so the amount and the
  wording come from one place.
- **"Vorschau" wiped the form, and "Wechseln" then booked the old configuration.** React resets
  an uncontrolled form once a `useActionState` action settles, and the Tarifwechsel form is
  submitted twice. With several positions it would have booked the *wrong line*. Found by
  driving the real page against the real database — it passes every test either way. Both change
  forms are controlled now, with the reason written above them.

### The mutation pass

Every claim worth making was broken in the source to check the test fails. Three survived the
first round and were repaired:

- removing the `FOR UPDATE`, the renewal-link check or the collection claim left the test green,
  because the **unique index** caught each one and the transaction simply rolled back — one
  invoice either way. Counting invoices cannot tell "skipped" from "crashed", so `run()` in the
  proof now asserts the pass reported **no failed step**; all three mutations fail now.
- `OPEN_INVOICE_STATUSES` → `"unpaid"` in `advancePeriods` and in `hasOpenInvoice` survived
  until two cases were added: a half-paid renewal must not buy another month, and must not wake
  a suspended server.

Also proven to fail under mutation: the state table (`cancelled → past_due`), the dunning
ladder's monotonic clamp, the coupon's spent and expired checks, the proration's both-sides
subtraction and its credit half, the coupon period being consumed and given back, the renewal's
due date, and the OpenAPI field-description check (a bare `$ref` with nothing beside it still
fails it).

### The ninety days

`tests/integration/billing-run.test.ts` walks a fake clock from 1 November to 20 December, most
days **twice** and often a third time forced: trial → renewal raised a fortnight ahead at
10,66 € for 16 of 30 days → trial ends → period does not advance → three collection rungs and no
more → reminder at +3, Mahnung at +10, services suspended at +14 → payment → reactivation at the
instant the money lands → period advances → full 19,99 € from the second renewal on → never
terminated, because the +30 rung found nothing open. Two passes race each other on a warmed pool
and produce one invoice between them, with neither reporting a failure.

### Decisions taken here, open to being overruled

- **A downgrade taken immediately books credit rather than a correction.** See above. The
  alternative is a Rechnungskorrektur that credits positions it cannot honestly name.
- **A change that changes nothing is refused.** With `period_end` it would occupy the item's one
  pending slot, and on the customer's timeline it reads "Tarifwechsel auf VPS M" while nothing
  happened. The *price* is part of the comparison, so re-confirming an unchanged configuration
  at a new catalog price is still a change.
- **A renewal that comes to 0,00 € issues no document.** The period still advances — step 4 asks
  whether an invoice is *open*, not whether one exists — and a 0,00 € invoice would burn a
  gapless number on a demand for nothing.
- **Credit is spent through `payFromCredit`, not as an invoice line.** Same path as the
  customer's own button, so an invoice cannot be settled by two mechanisms that do not know
  about each other. It is capped at what is owed; spending the whole balance would hand the
  overshoot straight back as credit, which is a loop rather than a payment.
- **A customer cancels only to the end of the period they have paid for.** Ending today would
  forfeit days they already bought and nothing here refunds them. The operator can still end one
  immediately.
- **A grouped renewal invoice is per customer + currency + billing *day*.** The plan asks for
  customer and currency; an invoice has one due date, and bundling two subscriptions that fall
  due a fortnight apart would make one of the two figures wrong.
- **`transitionSubscriptionIn` no longer clears `cancel_at_period_end`.** Becoming active again
  happens for several reasons and only one of them means "the cancellation is off"; that one is
  `resumeCancellation`, which clears it itself. It previously let resuming a *paused* Abo
  silently un-cancel it.
- **`tsx` is now an explicit devDependency.** It was already installed as drizzle-kit's
  transitive dependency and four npm scripts relied on that; the worker makes it a *production*
  entry point, which is a different thing to rest on a transitive dep for.

### Still open in this phase

- [ ] **Nothing collects for the dunning fee itself.** The fee invoice is raised, numbered and
      linked, and it is dunned like any other invoice — but it is not added to the retry ladder
      of the invoice that caused it, so a customer with auto-charge pays the renewal
      automatically and the 5,00 € fee by hand. The default is 0,00 €, so nobody is affected
      yet.
- [ ] **A failed job is not retried from the Jobs page.** pg-boss's own `retry()` would do it,
      but it needs a pg-boss instance in the web process, and the whole point of the split is
      that there is not one. "Jetzt abrechnen" is the retry and it is gefahrlos; the page says
      so. If a proper redrive is wanted, the honest shape is a second queue the worker listens
      on, not a boss instance in a request.
- [ ] **SCA on a renewal reaches nobody.** `collectIssuedInvoice` already mails an
      authentication link on `requires_action`, and there is still no SMTP relay — so an
      off-session renewal that needs SCA fails silently into the log. Phase 7 brings Graph.
- [ ] **Services do not actually stop.** Suspension writes `service.status = 'suspended'` and a
      timestamp; no module acts on it until Phase 8. The billing record is right and the machine
      keeps running.
- [ ] **A pending plan change is not shown on the renewal invoice's preview.** The renewal
      applies it correctly when it builds the lines, but nothing tells the customer in advance
      what the next invoice will say.

## Phase 7 — Ticketing mit einem Microsoft-365-Postfach · done

`npm run typecheck`, `npm run lint`, `npm run format`, `npm run test` (823 tests),
`npm run build` and `npm run openapi:generate` are green.

**There are no tenant credentials for this installation, and none were gone looking for.**
Everything below is written against the documented Graph contract and tested against
hand-written payloads and a fake channel (`tests/helpers/graph.ts`). `docs/m365-setup.md`
has the exact PowerShell an administrator runs in Entra and Exchange, including the
Application Access Policy that restricts the app to the support mailbox — without which
`Mail.ReadWrite` as an *application* permission is every mailbox in the tenant.

### One message, one path

Every route in — the webhook's notification, the five-minute delta reconciliation and the
operator's "jetzt abholen" button — ends in `processInboundMessage()`
(`src/server/tickets/inbound.ts`). A second path would be a second answer to "has this
message already been filed", and the one that was wrong would be the one that filed it
twice. The order is deliberate:

1. fetch the message **from the provider**. Nothing in a notification is trusted to say
   what arrived;
2. claim it — `inbound_mail (mailbox, internet_message_id)`;
3. decide whether it may become a ticket message at all (loop protection), before
   anything is written or sent;
4. thread it, match the sender, fetch the attachments;
5. write the ticket and the message in one transaction, under the unique index on
   `ticket_message.internet_message_id`;
6. mark it read and move it to `Processed`;
7. only then mark the claim handled.

A failure anywhere before 7 leaves the claim open, so the next pass is a real retry — and
the unique index means that retry cannot double what the first attempt did write. That
split is the one `claimEvent()` / `applyPayment` already had: the claim keeps the common
case off the database, the index is the safety net.

**What each key speaks for**, stated because Phase 6 shipped two defects that were this
question answered carelessly:

- `inbound_mail (mailbox, internet_message_id)` speaks for **one email message in one
  mailbox**. The RFC 5322 Message-ID rather than the provider's id, because the provider's
  id changes the moment the message is moved — which is the last thing we do to it. A
  message with no Message-ID gets a synthetic one derived from mailbox, sender, subject
  and receipt instant, so it is still one message and not two.
- `mail_notification (mailbox, resource_id)` speaks for **one pending look at one
  message**, and is deliberately re-claimable: a later change to the same message deserves
  another look. A burst of five notifications is one fetch.
- `auto_reply_budget (recipient, window)` speaks for **one sender's allowance in one
  hour**, claimed with a conditional `UPDATE … WHERE count < limit` so two workers racing
  on the same autoresponder send one reply between them.

### The webhook's signature check is its authorization

`/api/webhooks/msgraph` does two things and no third. It answers Graph's `validationToken`
handshake verbatim as `text/plain`, before anything else happens; and it checks
`clientState` — a 32-byte secret we minted when the subscription was created, stored
**hashed** (`hashToken`, as an API key is) and compared in constant time — per entry.

Nothing in a payload may name the row it acts on. A valid notification causes one
`mail_notification` row saying "look at this message id in this mailbox"; the worker then
fetches that message from Graph itself. A forged notification that somehow got past the
clientState could provoke a lookup and nothing else.

It answers **202 whatever happened**, including a batch where every entry was refused:
Graph retries a non-2xx for hours and then disables the subscription, and a forged
delivery must not be able to do that to a real one.

### Threading, strongest signal first

`resolveThread()` tries three, in this order and for these reasons:

1. **`[TKT-00042]` in the subject.** The one signal that survives a reply from a different
   address, a forward, and a client that drops every threading header. The counter is
   deliberately **not per year** — a number reused two Januaries apart would join two
   customers' conversations.
2. **`In-Reply-To` / `References` against the ids we stored.** Exact and unforgeable in
   practice. Newest match wins, with the ULID as tiebreaker: two messages easily share a
   `sentAt`, and an arbitrary winner files the reply onto whichever ticket the index
   returned first.
3. **The channel's `conversationId`**, scoped to the mailbox, because Exchange will put two
   unrelated messages with the same subject into one conversation.

All three follow `merged_into_ticket_id` to the ticket that actually holds the
conversation. A merged ticket keeps its number and its row for exactly that reason.

**A reply goes to the people the ticket already knows about** — the requester plus the
senders of inbound messages that matched a contact of *this* ticket's account — and to
nobody the request names. A ticket number travels on a subject line, so anybody who learns
one can post into the conversation; a reply that went straight back to them would turn a
guessable number into a way of reading somebody else's support history. A stray sender is
filed, flags the ticket (`unknown_sender`) and is shown to staff, who can link the account
if it really is one.

### A thing that generates its own input will loop

`classifyInbound()` refuses, in this order: our own outbound copy (recognised by the
Message-ID Exchange gave the draft, which is why the outbound path reads it back **before**
sending — once sent, the draft moves to Sent Items and its id changes with it); anything
from one of our own mailboxes, From or envelope sender; a bounce, by null Return-Path, DSN
content type, `X-Failed-Recipients`, or a postmaster/mailer-daemon/Exchange NDR sender;
`Auto-Submitted` ≠ `no`; `X-Auto-Response-Suppress`. A bounce is filed nowhere and answered
never — opening a ticket addressed to an address that has just been proved undeliverable
is the first step of a loop with the far side's postmaster.

Separately, `isAutomated()` decides whether anything may be sent *in answer*: it also
catches `Precedence: bulk|list|junk` and `List-Unsubscribe`. An out-of-office is worth
filing against a ticket and never worth answering.

### Stripping, sanitising, and what actually protects the page

The original arrives, is **sanitised**, and is kept whole (`original_html`). The display
copy is the sanitised body with the quoted history and the signature cut off
(`display_html` / `display_text`). Sanitise first, then strip, deliberately: stripping
looks for markers in the markup, and a message that got to decide what the stripper sees
could hide its history behind a `<script>` the sanitiser would have removed afterwards.

If stripping would leave nothing, the whole body is kept. A reply that is one line under a
quote is the common case; an empty message in the queue is how a question gets missed.

**What protects the admin page is not the sanitiser.** The conversation renders a body
inside `<iframe sandbox srcdoc=…>` with neither `allow-scripts` nor `allow-same-origin` —
a boundary the *browser* enforces. `sanitizeHtml` is the second layer and is written in the
knowledge that a hand-rolled sanitiser always has holes. No new dependency (rule 12):
`sanitize-html` wants `htmlparser2`, most alternatives want a DOM, and the frame is the
half that cannot be argued with.

### Attachments

Downloaded **before** the transaction that records them — a storage write is not
transactional and holding a transaction open across a network fetch is how a pass becomes a
lock queue — under keys minted from the ids the insert will carry. A transaction that rolls
back, or an insert the unique index turns into a no-op, leaves bytes nothing points at, and
`removeOrphans()` is the way back. The sender's filename never reaches the storage key: the
key is a path on the filesystem in the local backend, and `assertStorageKey` would refuse
most of what arrives. Oversized attachments are recorded as skipped rather than silently
dropped, and the size is checked again against what actually arrived, because Graph's
reported size includes MIME overhead.

The one download route serves both sides (`/client/tickets/attachments/[id]`, as the
invoice PDFs do). Scope is a join — attachment → message → ticket → customer — so a
customer asking for somebody else's id is refused by the `where` clause; anything hanging
off an **internal note** is staff-only by the same query.

### Outbound, and the system's own mail

`replyToTicket()` sends through the department's mailbox, replying in place so the provider
keeps the thread together, with our own `data-virtify-quote` marker on the quoted history
so a client we have never seen still produces something strippable on the way back. The
record is written **after** the send: a reply recorded but never sent is a customer waiting
for an answer that exists only in our database, while a reply sent but not recorded is
picked up as inbound on the next pass and filed anyway.

`MailTransport` (`src/server/mail/transport.ts`) is the second half of the phase: every
system notice — the invoice, the Mahnung, the SCA link — went through nodemailer to an SMTP
relay this installation has never had, so they reached the log and nobody else. There are
two ways out now, `smtp` and `graph`, chosen by a **setting** rather than an environment
variable. A `graph` transport with no sender mailbox falls back to SMTP and says so, rather
than dropping an invoice.

### The queues

- `tickets/sweep`, every five minutes: drain the notifications the webhook wrote, then a
  delta query per mailbox. `missed: "skip"`, deliberately unlike the billing run's `once` —
  there is nothing a five-minute-old sweep can do that the one in two minutes' time will
  not.
- `tickets/subscriptions`, hourly: create and renew the Graph subscriptions. Graph grants
  at most 4230 minutes and then stops delivering silently; the renewal happens with a day
  to spare, and a subscription Graph has forgotten (404) is marked removed so the next pass
  creates a fresh one instead of patching a corpse.
- There is deliberately **no** `ticket_run (run_day)` equivalent of `billing_run`. A mail
  sweep is not a daily event that must happen once; a row saying "the sweep has run today"
  would be exactly the wrong claim to make.
- A delta link Graph no longer accepts (410) is cleared, so the mailbox is reconciled
  again. Keeping it would mean the mailbox is never reconciled again, which is the quiet
  failure the delta query exists to prevent.

### Surfaces

- Admin: `/admin/tickets` with the queue, the counters and the filters; the detail page
  with the conversation, internal notes, canned replies, reply with CC, assign, status,
  priority, linking an account, merge and **unmerge**; `/admin/settings/mail` for the Graph
  channel, the departments and the state of the notifications, with "jetzt abholen" and
  "Benachrichtigungen prüfen" calling the same functions the cron does.
- Client: `/client/tickets`, `/client/tickets/new` and the detail page with reply and
  close. Honours `customer_contact.can_tickets`.
- API: `GET`/`POST /api/v1/tickets`, `GET /api/v1/tickets/{id}`,
  `POST /api/v1/tickets/{id}/messages`, all in the OpenAPI registry under the `Tickets` tag
  with per-field descriptions, examples and error shapes. New permissions `tickets.write`
  and `tickets.manage`; `tickets.read`/`reply`/`write` are in `CUSTOMER_SCOPES`, and
  `tickets.manage` deliberately is not — the mailbox is the operator's.

### Tests (115 new, 823 in all)

- `tests/unit/ticket-threading.test.ts` — the tag parser's generosity and its refusals (a
  bare `TKT-00042` in prose is not a tag, nor is a ten-digit one), `References` in every
  separator a client emits, the reply-prefix stripper in four languages.
- `tests/unit/ticket-sanitize.test.ts` — script removal including an unclosed one, every
  `on*` attribute in one rule, `javascript:` in seven spellings, `data:image` allowed and
  `data:text/html` refused, `expression()` and `position:fixed` out of styles.
- `tests/unit/ticket-quoting.test.ts` — the markers Outlook, Gmail, Apple Mail and
  Thunderbird actually emit, interleaved quoting kept, and the refusal to return an empty
  message.
- `tests/unit/ticket-loop.test.ts` — every ignore reason, their order, and the three
  independent bounce signals.
- `tests/unit/graph-channel.test.ts` — the client against a recorded `fetch`: the token
  cached, the secret never in a thrown message, delta paging, the folder created once, and
  the draft→read→send order.
- `tests/integration/tickets-inbound.test.ts` — the pipeline against a real Postgres: all
  four threading outcomes and their **order** when two disagree, a re-delivery under the id
  the move minted, a claim reopened mid-flight, the loop refusals and what they record,
  attachments stored/skipped/orphan-cleaned/deleted, the auto-reply budget in both
  directions, merge and unmerge, who a reply goes to, and the delta cursor's two failure
  modes.
- `tests/integration/tickets-notifications.test.ts` — the clientState check, a mixed batch,
  a removed subscription, the reopen, the prune, the subscription lifecycle, and the route
  itself (handshake, 202-on-forgery, 400 on a malformed envelope).
- `tests/integration/tickets-api.test.ts` — the four endpoints through the real handlers.

**The mutation pass.** Thirty-two claims were broken in the source to check the test fails.
Two survived and were turned into fixes rather than into tests of the old behaviour:

- the **message-id match had no tiebreaker**, so a `References` chain naming two tickets
  with the same `sentAt` filed the reply onto whichever the index returned first. The ULID
  is the tiebreaker now (rule 1's cursor, used as one).
- the **conversation fallback excluded merged tickets instead of following the merge**, so
  a reply with nothing but a conversation id opened a *new* ticket beside a conversation
  that had been merged. It follows the merge now, like the other two branches.

Two defects in the sanitiser were found by the tests as they were written: an unclosed
`<script>` left its contents standing as text (a raw-text element now swallows the rest of
the document, which is what a browser does), and `a < b und c > d` was read as a `<b>` tag,
inventing markup and — worse — not escaping the `<`. A tag name now has to follow `<`
immediately.

Two **test-helper** collisions were found and fixed, which is the other half of what Phase
6 warned about: the fake channel minted subscription ids and sent-message ids from
per-instance counters, so a second channel in the same database collided with the first
one's unique indexes.

### Decided here, open to being overruled

- **Certificate authentication is documented but not implemented.** `docs/m365-setup.md`
  says plainly that a certificate is the better way and gives the PowerShell for it; the
  settings schema already carries `certificatePrivateKey` / `certificateThumbprint`. What
  the client does today is `client_credentials` with a secret. Signing a JWT assertion is
  half a day's work and it is the first thing to do before this goes live with real
  credentials.
- **A department owns exactly one mailbox, and a mailbox exactly one department.** Two
  would make "which queue does this belong to" a coin toss whose answer could differ
  between a notification and the reconciliation pass.
- **A customer's reply through the portal or the API is not mailed anywhere.** It is
  recorded as inbound and appears in the queue. Mailing it back to the customer would be a
  loop; mailing it to staff is Phase 9's notification work.
- **The acknowledgement is sent outside `processInboundMessage`.** A mail that fails to
  send must not roll back the ticket it was acknowledging.
- **`on_hold` is the one status a customer's reply does not move.** Somebody decided to
  park the ticket, and a reminder mail should not undo that decision.
- **A ticket number is not per year.** It is a threading key that goes out on a subject
  line; the invoice series' per-year reset would be a security property, not a cosmetic
  one.
- **The ticket API has no `include_notes`, for staff keys either.** A note is written in
  the knowledge that it stays inside. The admin page is where it is read.
- **The webhook writes a row rather than enqueuing a pg-boss job.** The web process holds
  no pg-boss instance (Phase 6's decision, and the reason is unchanged), so the fast path
  is a `mail_notification` row the sweep drains within the minute. A support mail arriving
  up to a minute late is a cost worth paying to keep a background library out of a
  request-scoped server.

### Deliberately left out

- **Inline images are stored but not re-addressed.** `content_id` is kept and the sanitiser
  allows `cid:` URLs, but nothing rewrites them to point at the attachment route, so an
  embedded image shows as a broken one in the admin frame. The bytes are there; it is a
  rendering step.
- **Attachments on an outbound reply can only be ones already on the ticket.** There is no
  upload field in the admin reply form. The channel's upload-session path for >3 MB is
  implemented and covered by nothing but its own code path.
- **No SLA, no auto-close, no customer satisfaction follow-up.** None of it is in the build
  plan for this phase.
- **No ticket search.** The queue filters by department, status, priority, assignee and
  unknown sender; there is no full-text search over the conversation.
- **The admin dashboard has no ticket widget.** `/admin/tickets` carries the counters.

### Reviewed after the fact, and fixed

Ten lenses over the phase, three independent skeptics per candidate, and every fix below
mutation-checked by hand afterwards — a change was reverted and the suite had to go red, or
the test was not holding anything. 823 tests became 857.

**The one that would have stopped the phase working at all.** `POST …/messages/{id}/send`
answers **202 Accepted with an empty body** — Microsoft's words — and `call()` short-circuited
only on 204, so `Response.json()` ran on nothing and threw. Every outbound mail would have
thrown *after it had gone out*: the reply unrecorded, an error on the operator's screen, and a
second copy at the customer the moment they pressed send again. The fake answered `/send` with
204 and so made the assumption true by construction; it now answers 202 the way Graph does,
and the body decides whether there is anything to parse, not the status.

**Who owns a ticket, changed by a number anybody can guess.** An inbound message matched to a
ticket by its `[TKT-00123]` subject tag was linking that ticket to the sender's account when it
had none — so any customer with a portal login could take over a stranger's conversation, in
their portal, staff replies and all, by sending one mail with a guessed number in the subject.
Adoption now happens only on a `message-id` match, the one signal that has to name an id we
minted or already received. A subject tag or a conversation id files the message, flags it and
leaves the linking to staff, which the ticket page already offers. The reply recipients were
built on exactly this reasoning; this was the same hole by the other door.

**Mail that was simply gone.** `reconcileMailbox` advanced the delta cursor whether or not the
messages on the page had been dealt with. Graph never reports a message twice for one token,
the message that threw is usually the one that was never claimed (the fetch comes first, the
claim second), and nothing reads an open `inbound_mail` row — so a message that failed once was
lost, silently, with a comment above the line saying it could not be. The cursor now waits for
a page that had failures, which makes the delta path behave the way the notification path
already does. The cost is that a message which fails for ever holds its mailbox's place; that
is loud, and loud is this system's trade everywhere else.

**And the attachment that would have held it there.** Graph answers `$value` with 405 for an
item attachment and for a OneDrive reference, and 405 is not `gone`, so a forwarded calendar
invitation threw out of `downloadAttachments` and took the whole message with it. One
attachment is now skipped, named (`unreadable`) and counted in the sweep report; the message
is what the customer wrote.

**A ghost ticket per mail sent to two of our mailboxes.** When the unique index on
`ticket_message.internet_message_id` refused a message, the transaction returned "duplicate"
and *committed* — including the ticket it had opened and numbered a moment earlier. A customer
copying `support@` and `abuse@` got a real ticket in one queue and an empty one in the other.
It now rolls back, which hands the number back with it, and the claim records where the message
really is.

**The attachments of a message that was filed.** The `catch` around the transaction also
covered everything after the commit, so a dropped connection between the commit and
`markInboundHandled` deleted the storage bytes of a message the customer can see. Only the
transaction is in the `try` now.

**Merging, which moves messages between accounts.** `mergeTickets` never checked that the two
tickets belong to the same customer. An unowned source onto an owned target is the direction
that is the point of merging and is still allowed; anything else is refused. And a second merge
was overwriting the first's `merged_from_ticket_id`, so unmerging the inner ticket handed back
an empty one while its messages stayed where they were — the marker is now written once and
never rewritten.

**Automatic is a reason not to answer, not a reason not to listen.** `classifyInbound` was
refusing `Auto-Submitted` and `X-Auto-Response-Suppress` mail outright, which is the opposite
of what `loop.ts`'s own header says it does and the wrong half of the rule. In a hosting
mailbox that is a customer's monitoring saying a machine is down, a registrar's transfer
notice, a datacentre's maintenance window — all of it dropped where nobody would look for it.
It is filed and marked `automated`, which is the flag the acknowledgement already asks about,
so nothing automatic is ever answered automatically. A bounce stays refused: it is not a
message from anybody. **`postmaster@` is a person here** — RFC 2142 requires every domain to
have one and hosting customers write from it, usually about mail — so the address alone no
longer makes a bounce; it needs a marker a human's client does not set. And a repeated
`Auto-Submitted: no` arrives joined with a comma, which read as one string is not `no`, so
every occurrence is judged separately.

**Quote stripping that had been switched off by its own sanitiser.** `prepareBody` sanitises
before it strips, deliberately — but the allowlist dropped `id`, `type` on `blockquote` and
`data-` attributes, which is where five of the eleven markers live: Outlook desktop, Outlook
Web, Apple Mail, the signature marker, and **our own**, the one put on every outbound reply so
a client we have never seen is still stripped. Every Outlook reply therefore arrived with the
whole thread under it and re-quoted it on the way back out. The three attributes now survive,
each narrowed to the one thing it is for — `id` only as one of three fixed words, `type` only
as `cite`, ours rewritten to a constant — so none of them can carry a value a sender chose.

**Microsoft Graph throttles and says so properly.** Nothing honoured `Retry-After`, and no
request was retried at all. A busy morning would have been a sweep reporting failures and
coming back five minutes later to be throttled again on the same volume. 429, 503 and 504 are
now retried up to four times, honouring the documented wait and backing off exponentially when
there is none, capped at thirty seconds; a 401 re-authenticates once, because a second refusal
of a freshly minted token is real.

**Smaller, and each of them real.**

- "Erneut verarbeiten" told the operator the message would be fetched again. Clearing the claim
  did nothing of the sort — nothing reads an open `inbound_mail` row, the cursor had moved past
  it and it was sitting in Processed. It now writes the one `mail_notification` row the webhook
  writes, which is where work waits.
- The portal says "Du bekommst eine Bestätigung an deine Kontaktadresse" and sends one now. It
  is not a nicety: it is the mail the customer replies to, and the tag in its subject is how
  that reply comes back to this ticket instead of opening a second one.
- A staff reply that is sent but cannot be recorded comes back as `recorded: false` and the
  operator is told, by name, not to send it again. The old comment claimed the next inbound pass
  would file it; the loop protection refuses it, which is its job.
- `sendTicketConfirmation` gave the hourly allowance back when the *recording* failed, for a
  mail that had gone out. Only a failed send gives it back now.
- The acknowledgement wrote a ticket message with no audit row (rule 8), and not in a
  transaction with it (rule 4). Both now.
- A contact without `can_tickets` could still close the account's tickets: the page hid the
  form, the server action did not check.
- The message count on a customer's ticket list counted internal notes, telling them how many
  there are and that they exist.
- A plain-text message's quoted history could not be shown at all — the toggle had the same
  expression in both branches.
- Graph's English error text, URL and 300 bytes of response body were shown to staff as the UI
  message. The log keeps them; the screen gets a German sentence.
- The Graph subscription asked for exactly the documented ceiling of 4230 minutes, measured
  against our clock and refused against Microsoft's. Ten minutes of margin.

**A test that was holding nothing.** No test asserted that `loadTicket` withholds an internal
note from the customer — the two that mention notes both cover the *serializer*, and the portal
page has no serializer in front of it. Removing the filter broke nothing. Two more guards had a
`return` where they meant `throw`, so the test passed when its setup had failed.


### Still open in this phase

- [ ] **Nothing has ever talked to Microsoft.** Every Graph interaction is tested against
      hand-written payloads. The first real tenant will find things this cannot: the exact
      shape of `internetMessageHeaders` on a forwarded message, whether `createReply`
      behaves as documented on a shared mailbox, and how the Application Access Policy's
      propagation delay feels in practice.
- [ ] **Certificate authentication** — see above.
- [ ] **A failed `mail_notification` is retried for ever.** It stays pending with
      `attempts` counted up, and nothing gives up on it or surfaces it beyond the settings
      page's counters. A message Graph will never hand over keeps being asked for.
- [ ] **`ticket.first_response_at` is written but never read.** It is the raw material for
      a response-time report that does not exist yet.
- [ ] **Merging does not deduplicate.** Two tickets merged keep both their opening
      messages; nothing notices that they say the same thing.
- [ ] **A message that fails for ever holds its mailbox's delta cursor.** The fix above
      chose a stalled, visible mailbox over a silently lost message, which is the right way
      round — but there is no way for an operator to say "give up on this one". The sweep
      report names the message and the mailbox stops advancing; what is missing is a button.
- [ ] **A merge chain unmerges only inwards.** `C` into `B` into `A`, then unmerging `B`,
      leaves `C`'s messages in `A` — they belong in `B`, which is still merged away. The
      provenance is no longer destroyed, so the data to do this properly is there.
- [ ] **No index on `ticket.merged_into_ticket_id` or `ticket_message.merged_from_ticket_id`.**
      Every ticket detail view and every unmerge filters on one of them.
- [ ] **`skippedAttachments` is counted in the sweep report and nowhere else.** The customer
      who sent a 60 MB logfile is not told it did not arrive, and neither is the ticket.

## Phases 5–11

| Phase | State | Notes |
|---|---|---|
| 5 Payments | done | See above. |
| 6 Subscriptions, dunning | done | See above. The older `contract` table still exists beside `subscription` and is created by hand; nothing in the recurring run touches it. |
| 7 Ticketing (M365 Graph) | done | See above. No tenant credentials exist yet; the channel reports itself unconfigured and every job that would talk to Microsoft does nothing. |
| 8 Provisioning (Proxmox) | not started | Phase 2 put the registry interface and the `none` module in `src/server/provisioning`; Phase 4 added the `service` table and Phase 6 now moves its `status` — suspended at the dunning rung, terminated when an Abo ends, created and retired by a quantity change — but no module acts on any of it. The lifecycle methods and the Proxmox module are this phase's, and the hooks they attach to already exist. |
| 9 Client portal polish, i18n | not started | German only, no i18n layer, no `email_templates`. |
| 10 Reports, webhooks, API | not started | |
| 11 Hardening, deploy | not started | |

## Carried over from before the conversion

- **Timestamps are `timestamp`, not `timestamptz`** (58 columns before Phase 7, 91 after —
  migration `0022` followed the existing pattern rather than deviating from it), against hard
  rule 9. Postgres
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
- Operational, not code: `STRIPE_WEBHOOK_SECRET` and `PAYPAL_WEBHOOK_ID` need a public URL —
  or, since Phase 5, a row in `/admin/settings/payments`, which is the same two secrets
  encrypted at rest; PayPal reference transactions need PayPal's written approval before the
  recurring mode is set to `vault`; Stripe receipt mails must be turned off, because our own
  receipt is the one that names our invoice; a real outbound SMTP relay is still missing, and
  without one the SCA link and every failure notice only reach the log; the new AGB § 7 and the
  Datenschutz sections want reading by the operator; a Steuerberater should see a sample invoice
  before go-live — Phase 3 makes that concrete: `/admin/settings/tax` is where the switch is
  scheduled, and the sample to show them is any PDF from `/admin/invoices`. Phase 5 adds one
  question for them: a credit top-up takes money with no document behind it.
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
