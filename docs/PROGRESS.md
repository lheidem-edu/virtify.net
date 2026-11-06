# Progress

State of the conversion described in `docs/BUILD_PLAN.md`. Phases are that file's
numbering. "Existing" means the portal already had it before the conversion started and it
still has to be reviewed against the phase's requirements, not that the phase is finished.

## Phase 0 — Scaffold · in progress

Done:

- [x] `CLAUDE.md` with the project brief and the recorded deviations from the original plan
- [x] `docs/BUILD_PLAN.md`, `docs/PROGRESS.md`
- [x] `src/lib/ulid.ts` — monotonic factory, `isUlid()`, prefixed `createId()`, `zUlid`, `zId()`.
      `src/lib/db/id.ts` now re-exports it so there is one generator.
- [x] `src/lib/money.ts` — integer cents: `add`, `subtract`, `multiply`, `percent`, `allocate`
      (largest remainder), `split`, `prorate`, `format`, `toDecimalString`, `parseAmount`
- [x] `src/lib/crypto.ts` — AES-256-GCM, versioned ciphertext, key fingerprint, keyring with
      rotation, AAD context binding, `hashToken`/`tokenMatches` for API keys
- [x] `src/lib/env.ts` + `src/instrumentation.ts` — zod-validated environment, checked once at
      server boot; `.env.example` documents `APP_ENCRYPTION_KEY`
- [x] Vitest (`vitest.config.mts`, `npm run test`), 53 unit tests over the four modules
- [x] `npm run typecheck` / `format` scripts

Still open in this phase:

- [ ] Route restructure: `(site)` → `(marketing)`, `account` → `(client)/client`,
      `admin` → `(admin)/admin`, with redirects from the old paths (invoice mails link to
      `/account/invoices/<id>/pdf`, so the redirects are not optional)
- [ ] Move `src/lib/db/schema.ts` to `src/db/schema/*.ts` per domain + `_columns.ts`
      (`ulidPk()`, `ulidFk()`, `timestamps()`, `money()`); point `drizzle.config.ts` at it
- [ ] Move `src/lib/{documents,payments,legal}` to `src/server/**`; move `src/lib/components/*`
      to `src/components/*` so no React lives under `src/server`
- [ ] `src/server/openapi` skeleton: registry, RFC 9457 problem schema, cursor envelope,
      `/api/v1/openapi.json`, Scalar at `/api/docs`
- [ ] Have `src/lib/documents/totals.ts` use `money.ts` (it rounds with `Math.round`, which is
      not symmetric for the negative quantities a Rechnungskorrektur uses)
- [ ] Have `src/lib/payments/config.ts` read `env` instead of `process.env`
- [ ] Dockerfile (standalone output) + worker entrypoint stub
- [ ] Playwright (plan defers the e2e suite itself to Phase 11)

## Phases 1–11

| Phase | State | Notes |
|---|---|---|
| 1 Auth, RBAC, customers | existing, partial | Better Auth for clients and staff separately, TOTP, verification, reset, staff invites. Missing: `customers`/`customer_contacts` as their own tables (today a customer *is* a user), permission strings, `audit_log`, API keys, `/api/v1/customers`. |
| 2 Product catalog | not started | No `products`, pricing matrix, config options or coupons. The storefront sells nothing yet. |
| 3 Tax + invoicing | existing, partial | Invoices draft → issued → paid → corrected, gapless numbering via `document_counter` with `FOR UPDATE`, DIN 5008 PDF, XRechnung CII, Rechnungskorrektur. Missing: `TaxStrategy` interface (§ 19 is hardcoded in `totals.ts`), `tax_mode_history`, per-line tax snapshots, the immutability trigger, the § 19 threshold monitor, PDF storage behind an interface, GiroCode. |
| 4 Cart, checkout, orders | not started | `contract` and `offer` exist and are created by hand in the admin area; there is no cart, no self-service order. |
| 5 Payments | existing, partial | Stripe + PayPal, stored payment methods, off-session collection, webhooks with dedupe, settlement in one transaction. Missing: the `PaymentGateway` interface the plan asks for, bank transfer as a gateway, partial payments, overpayment → credit ledger, refunds, disputes, gateway credentials in encrypted settings. |
| 6 Subscriptions, dunning | not started | No pg-boss, no renewal run, no dunning, no proration. `contract` carries the term arithmetic (`src/lib/documents/contract-term.ts`) but nothing bills it automatically. |
| 7 Ticketing (M365 Graph) | not started | Mail goes out over SMTP via nodemailer. |
| 8 Provisioning (Proxmox) | not started | |
| 9 Client portal polish, i18n | not started | German only, no i18n layer, no `email_templates`. |
| 10 Reports, webhooks, API | not started | |
| 11 Hardening, deploy | not started | |

## Carried over from before the conversion

- Legal texts are editable in the admin area and stored as versions with an effective date.
  **Bug:** on `/admin/legal` a version published with today's date lands in `inForce`, so it never
  offers "Kunden benachrichtigen". The announce action should be offered for the newest published,
  not-yet-announced version.
- `src/lib/legal/parse.ts` was written for a plain-text legal format and nothing consumes it yet.
- Operational, not code: `STRIPE_WEBHOOK_SECRET` and `PAYPAL_WEBHOOK_ID` need a public URL;
  PayPal reference transactions need PayPal's written approval before
  `PAYPAL_VAULTING_ENABLED=true`; Stripe receipt mails must be turned off; a real outbound SMTP
  relay is still missing; the new AGB § 7 and the Datenschutz sections want reading by the
  operator; a Steuerberater should see a sample invoice before go-live.

## Decisions taken without asking, open to being overruled

- **npm, not pnpm.** The lockfile is npm's and switching buys nothing.
- **Prefixed ULIDs in `text`, not bare `char(26)`.** They are already in every table and in every
  stored gateway reference. The prefix is constant per table, so ULID cursor pagination still
  works, which was the plan's reason for the rule.
- **The marketing landing page stays at `/`.** The plan's own layout keeps `(marketing)` for the
  storefront, cart and checkout, so the pages become the shop front rather than being deleted.
- **`ulid()` takes no timestamp.** A monotonic generator silently ignores a seed behind the last
  one it saw, so seeding is only available from `ulidFactory()`, which owns its own state.
