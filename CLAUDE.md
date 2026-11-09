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
  nothing to validate against, on a code that asks for money)
- Provisioning: one `ProvisioningModule` interface (`src/server/provisioning/types.ts`),
  first module **Proxmox VE** over an API token, `fetch` and no SDK. Server credentials
  encrypted in `provisioning_server` (rule 6). **There is no Proxmox cluster for this
  installation and none is to be gone looking for** — see `docs/proxmox-setup.md` for what
  an administrator has to do in the cluster, including why the restricted token it asks for
  is also the reason suspension does not rely on `lock`
- Mail and ticketing: one `MailTransport` interface (`src/server/mail/transport.ts`) over
  nodemailer/SMTP and **Microsoft Graph**, picked by a setting rather than an environment
  variable; `src/server/tickets` with a pluggable `MailChannel`, first channel Graph, over
  `fetch` and no SDK. Graph credentials are encrypted in `mail_channel_setting`, with the
  environment as the fallback. **There are no tenant credentials for this installation and
  none are to be gone looking for** — see `docs/m365-setup.md` for what an administrator
  has to do in Entra and Exchange, including restricting the app to the support mailbox
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
    catalog/  billing/  tax/  storage/  jobs/  openapi/
    provisioning/        # the registry, the task runner, the IP pools
    provisioning/proxmox/ # the first real module: api, nodes, cloud-init, sanitize
    mail/                # the transactional layout + MailTransport (smtp | graph)
    tickets/             # the domain, and channels/ with the Graph implementation
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
cron pass off the database and is the only one of the four a human may deliberately bypass. It
speaks for **the whole night**, so only an unscoped pass may claim the bare day — a pass narrowed
to one customer claims `day#customer`, or billing one account by hand at 02:00 hands the 03:00
cron a finished row and every other customer is silently passed over until tomorrow. A pass that
*threw* did not finish: it is retried, unlike one that finished with per-step failures in its
report.

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
`followingPeriod` that moved it forward. **The way back gives back exactly what the way out
took, and no more** — a renewal that consumed no coupon period (because none was left) gets
none back, or an operator correcting an unrelated mistake hands out a discount nobody was
promised. A **cancellation goes through that same function**: a renewal is invoiced ahead of
its period, and that invoice is what reminds people to cancel, so a period that will not be
delivered is taken back in the cancellation's own transaction — only the cancelled Abo's
positions when the document groups several, and never a period that has already begun.

One message, one path: `processInboundMessage()` in `src/server/tickets/inbound.ts` is the
only way an email becomes a ticket message. The Graph notification, the five-minute delta
reconciliation and the operator's "jetzt abholen" all end there — a second path would be a
second answer to "has this already been filed", and the one that was wrong would be the one
that filed it twice. It fetches the message **from the provider** first (nothing in a
notification is trusted to say what arrived), claims it under
`inbound_mail (mailbox, internet_message_id)`, decides whether it may become a ticket
message at all, writes ticket and message in one transaction under the unique index on
`ticket_message.internet_message_id`, moves it to `Processed`, and *only then* marks the
claim handled. The key is the RFC 5322 Message-ID and not the provider's id, because the
provider's id changes the moment the message is moved — which is the last thing we do to it.

A ticket system mails back what it is mailed, into a mailbox that receives its own outbound
copies, so **loop protection is not a nicety**: `src/server/tickets/loop.ts` refuses our own
outbound (by the Message-ID Exchange gave the draft, read back *before* the send), anything
from our own mailboxes, and bounces, and `auto_reply_budget (recipient, window)` caps
acknowledgements per sender per hour with a conditional update — claimed before the send and
**given back** when the *send* fails, never when the recording does: the customer has that
mail, and an allowance handed back for it is the allowance the next message spends on a
second copy. **Automatic is a reason not to answer, not a reason not to listen** — the two
decisions that file live in `classifyInbound`, and whether anything automatic may go back in
`isAutomated`. `Auto-Submitted` ≠ `no` and `X-Auto-Response-Suppress` mark a message
`automated`, which is what the acknowledgement asks about; they do not refuse it, because in
a hosting mailbox the automatic mail is a customer's monitoring saying a machine is down. A
bounce is refused, because it is not a message from anybody — but `postmaster@` is a person
here and needs a second signal before it counts as one.

**A guessable signal may not decide who owns a ticket, and may not be replied to.** A ticket
number travels on a subject line and the numbers are sequential, so anybody who learns or
guesses one can post into the conversation. A reply therefore goes to the people the ticket
already knows about — the requester and the contacts of its account — and never to whoever
sent the last message; and an unowned ticket is linked to a contact's account only on a
`message-id` match, which has to name an id we minted or already received. Either rule
written the other way turns a guessed number into somebody else's support history, once
through the mailbox and once through the portal. A merge moves messages between tickets, so
it is the third door: it stays inside one account, except for the unowned source that is the
point of merging.

**The delta cursor only moves past mail that was dealt with.** Graph never reports a message
twice for one token and nothing reads an open `inbound_mail` row back, so advancing over a
message whose pass threw is a mail silently gone — and the one that threw is usually the one
that was never claimed, because the fetch comes first and the claim second. A page with
failures keeps its cursor, which makes the delta path behave the way the notification path
already does. A message that fails for ever then holds its mailbox's place, which is loud
rather than quiet, and loud is the trade this system makes everywhere else. That is also why
**one attachment may never take its message down**: Graph answers `$value` with 405 for an
item attachment, which is not `gone`, and one forwarded calendar invitation would otherwise
stop the queue.

**An empty body is a success.** `POST …/messages/{id}/send` answers `202 Accepted` with
nothing in it, so what is parsed is decided by the body and not by the status — keying it on
204 meant the most important call in the system threw *after the mail had gone out*. And
Graph throttles properly: 429 with `Retry-After`, honoured, with an exponential backoff when
it says nothing and a cap, because a worker holding a job open for a quarter of an hour is
its own failure.

A ticket's HTML is sanitised *and* rendered in `<iframe sandbox srcdoc=…>` with neither
`allow-scripts` nor `allow-same-origin`. The frame is what actually protects the page;
`sanitizeHtml` is the second layer, written in the knowledge that a hand-rolled sanitiser
always has holes.

One module call, one function: `runProvisioningTask()` in
`src/server/provisioning/runner.ts` is the only place anything in this codebase touches a
real machine. The worker's minute-by-minute sweep, the operator's „jetzt ausführen“, a
customer pressing „Neustart“ and `POST /api/v1/services/{id}/actions/{action}` all end
there — a second path would be a second answer to "may this customer reboot this server",
and the one that was wrong would be the one somebody found. It is also where **giving
things back** lives, in exactly two places: a successful `terminate` releases the addresses
and the reserved provider id, and an attempt that aborted before the provider was ever
asked releases exactly what *that attempt* took. Nothing else in the codebase releases
anything.

**A retry must not make a second VM, and only the provider's own id can say whether it
would.** So the VMID is *ours*: `GET /cluster/nextid` is asked once, written to
`provisioning_resource (server_id, kind, external_id)` **before** the clone, and the clone
is asked for with `newid=` that value. A retry then asks the cluster whether VM 101 exists
and either finds it — already done, success — or clones again under the same id, where
Proxmox's own `500 VM 101 already exists` is read as the same success. `provisioning_task
(service_id, action, request_key)` is the *work queue* and the "a retry is not a second
request" guard, and it is deliberately not the thing that makes a create safe; every
caller's request key is written out in `src/server/provisioning/tasks.ts`. The attempt
ladder is **per action**, because a uniform one is how a reboot reboots twice and a
reinstall destroys a customer's data twice.

**`service.status` is the billing record's word and it always wins.** `getStatus` writes
`service.provider_status`, a different column that nothing acts on, and a disagreement is
*shown* („läuft nicht, obwohl die Leistung aktiv ist“) rather than resolved. Writing a
reading back is how a VM an operator stopped by hand becomes `suspended`, gets woken by the
mirror in `wakeSettledIn` because its Abo owes nothing, and is stopped again by the next
sync: a machine flapping between two systems that each believe the other. The hooks fire on
the rows `applyServiceFollow` actually **moved**, never on the statuses they now have, which
is what keeps the same follow written twice from asking twice. And **no action runs on a
service that is not `active`** — without that, the whole dunning ladder is one button away
from being undone.

Anything from a customer's order form that reaches a cloud-init payload, a hostname or a
Proxmox parameter is attacker-controlled input. `src/server/provisioning/proxmox/sanitize.ts`
is the gate in front of it and `URLSearchParams` in `proxmox/api.ts` is the encoding — in
that order, because the only escaping worth relying on is "the value was never dangerous".

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
npm run worker                          # pg-boss: the daily billing run, the five-minute
                                        # mail sweep, the hourly Graph subscription
                                        # renewal and the minute-by-minute provisioning
                                        # sweep; its own process
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
