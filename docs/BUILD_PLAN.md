# Build Plan — Hosting Billing Panel

How to use this with Claude Code:

1. Put `CLAUDE.md` in the repo root and this file at `docs/BUILD_PLAN.md`.
2. Do **one phase per session**. Start each one in plan mode (Shift+Tab), paste the phase prompt,
   review the plan, then let it build.
3. At the end of each phase: tests green → `git commit` → `/clear` → next phase.
4. If Claude starts gold-plating: "Stick to the phase scope. Note extras in docs/PROGRESS.md."

All tables use `id char(26)` ULID primary keys (see CLAUDE.md rule 1).

---

## Domain model (reference for all phases)

| Entity | Purpose / key fields |
|---|---|
| `users` | Login identity (Better Auth). `type`: staff \| client |
| `staff_roles`, `staff_permissions` | RBAC for admins (e.g. `billing.write`, `tickets.reply`) |
| `customers` | Billing account. company/name, address, country, `vat_id` (+ validated_at), currency, language, credit balance, status, notes |
| `customer_contacts` | Users on an account with sub-permissions (billing, technical, tickets) + email addresses used for ticket matching |
| `product_groups`, `products` | Catalog. `type`: vps \| webhosting \| gameserver \| domain \| subscription \| other. `module` + `module_config` (jsonb) |
| `product_pricing` | Per product × billing cycle (monthly, quarterly, semiannual, annual, biennial, one-time) × currency. `setup_fee`, `trial_days` |
| `config_options`, `config_option_values` | Add-ons (extra RAM, IPv4, backups) with pricing per cycle |
| `orders`, `order_items` | Checkout result. Status: pending → active / fraud / cancelled |
| `subscriptions` | **The Abo / billing contract.** customer, billing cycle, currency, `status` (trialing, active, past_due, paused, cancelled, ended), `current_period_start/end`, `next_billing_at`, `cancel_at_period_end`, `auto_charge`, `payment_method_id`, `gateway` + `gateway_subscription_ref` (if gateway-native) |
| `subscription_items` | Product, qty, price snapshot, config options, optional `service_id` |
| `services` | A provisioned thing (VPS, webspace). `status`: pending, active, suspended, terminated. `server_id`, encrypted credentials, module data (jsonb). Belongs to a subscription item |
| `invoices` | draft → unpaid → paid / cancelled / refunded. number (null until finalized), dates, due date, totals, currency, buyer + seller snapshot, `tax_strategy` |
| `invoice_items` | Description, service period, qty, unit price, net, tax rate/category/rule snapshot, `subscription_item_id` |
| `credit_notes`, `credit_note_items` | Corrections / refunds referencing an invoice |
| `transactions` | Payments in/out. gateway, gateway_ref, amount, fee, status, raw payload |
| `payment_methods` | Stored gateway tokens per customer (Stripe PaymentMethod, PayPal vault token), label, default flag |
| `credit_ledger` | Customer credit balance movements |
| `coupons` | Percent/fixed, products/cycles, recurring n periods / forever / once, limits, validity |
| `tax_mode_history` | Active TaxStrategy + effective_from |
| `number_sequences` | Gapless counters (invoice, credit note, order, ticket). Format e.g. `RE-{YYYY}-{00000}` |
| `servers`, `ip_pools`, `ip_addresses` | Provisioning targets + IP management |
| `ticket_departments` | Name, linked `mailbox_id`, default assignee, SLA |
| `mailboxes` | M365 shared mailbox config: address, tenant, Graph credentials (encrypted), subscription id + expiry, delta link |
| `tickets` | Number (`TKT-00001`), customer (nullable), department, subject, status (open, answered, customer_reply, on_hold, closed), priority, assignee, `graph_conversation_id` |
| `ticket_messages` | Body (html + sanitized text), direction (in/out/internal note), author, `internet_message_id`, `in_reply_to`, `graph_message_id` |
| `ticket_attachments` | File metadata + storage key |
| `email_templates`, `email_log` | Templates (DE/EN) + sent mail log |
| `api_keys` | Hashed key, prefix for display, scopes, owner (staff or customer), last used |
| `webhook_endpoints`, `webhook_deliveries` | Outbound webhooks |
| `audit_log`, `settings`, `processed_events` | |

---

## Phase 0: Scaffold

```
Read CLAUDE.md. Scaffold the project exactly as described there:
- Next.js (latest stable, App Router, TS strict, src/ dir), Tailwind, shadcn/ui initialized
  with button, input, form, table, dialog, dropdown-menu, sheet, badge, card, tabs, sonner,
  and the TanStack data-table pattern.
- Drizzle + postgres driver, drizzle.config.ts, docker-compose.yml with Postgres 17.
- src/lib/ulid.ts: monotonic ULID factory, isUlid() validator, zod schema `zUlid` (26 chars,
  Crockford base32) with OpenAPI metadata. src/db/schema/_columns.ts with ulidPk(), ulidFk(),
  timestamps() (created_at/updated_at timestamptz), money(name). Tests: ULIDs generated in the
  same millisecond are strictly increasing.
- Typed env validation in src/lib/env.ts with zod. App crashes on boot with a clear message if invalid.
- src/lib/money.ts (integer cents, add/sub/multiply by rate half-up, allocate, format de-DE) + tests.
- src/lib/crypto.ts (AES-256-GCM encrypt/decrypt with versioned key prefix) + tests.
- src/server/openapi skeleton: OpenAPIRegistry, shared schemas (Problem = RFC 9457 problem+json,
  cursor pagination envelope { data, next_cursor, has_more }), spec builder, route GET
  /api/v1/openapi.json, and Scalar at /api/docs (dark/light, API-key auth preset, German + English
  intro in info.description written in Markdown).
- Vitest + Playwright, ESLint, Prettier, pnpm scripts from CLAUDE.md.
- Dockerfile (multi-stage, standalone output) for Dokploy; worker entrypoint stub.
- docs/PROGRESS.md with the phase checklist.
No business features yet.
```

## Phase 1: Auth, RBAC, customers

```
Implement auth and customer accounts.
- Better Auth with Drizzle adapter (configure it to generate ULID ids): email+password,
  email verification, password reset, TOTP 2FA (mandatory for staff), session management page.
- users.type = staff | client. Middleware: /admin/** staff only, /client/** clients only.
- Staff RBAC: roles + permission strings, `requirePermission()` helper. Seed "Super Admin".
- customers + customer_contacts per BUILD_PLAN domain model.
- `getCurrentCustomer()` helper that every client-area query must use for scoping.
- audit_log + `audit()` helper; wire into customer create/update.
- Admin: customer list (search, filter, cursor pagination), customer detail with tabs
  (Overview, Contacts, Subscriptions, Invoices, Transactions, Tickets, Notes, Log): placeholders ok.
- Client: registration (company or private person, country, optional VAT ID), profile edit.
- API keys: create/revoke in admin and client area; shown once, stored hashed (sha256 + prefix).
  Auth middleware for /api/v1 via `Authorization: Bearer`. Register the security scheme in OpenAPI.
- First documented endpoints: GET/POST /api/v1/customers, GET/PATCH /api/v1/customers/{id}.
- Seed: super admin, 3 demo customers.
Tests: scoping can't leak other customers' data; permission checks; API key scope enforcement.
```

## Phase 2: Product catalog

```
Implement the product catalog.
- Schema: product_groups, products, product_pricing, config_options, config_option_values, coupons.
- products.module + module_config jsonb validated by a zod schema the module provides (create the
  module registry interface with a "none" module; real modules in Phase 8).
- Product type `subscription` = pure recurring product without provisioning (support plans,
  managed services, licenses).
- Admin CRUD: groups (sortable), products (pricing matrix: cycles × currencies, setup fee,
  trial days), config options, coupons.
- Storefront: group overview, product page with cycle selector + config options, live price
  calculation via one shared server function (single source of truth for checkout and API).
- API: GET /api/v1/products, GET /api/v1/products/{id}, POST /api/v1/products/{id}/quote. Documented.
Tests: price calc incl. config options, setup fee, trial, coupons (once / n periods / forever).
```

## Phase 3: Tax strategies + invoicing engine (critical, be thorough)

```
Implement src/server/tax and src/server/billing/invoices. Correctness over speed.
- TaxStrategy interface per CLAUDE.md. Strategies:
  * kleinunternehmer (ACTIVE): 0%, category E, note "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
  * regular-vat (DISABLED, fully tested): DE 19%; EU B2B with VIES-validated VAT ID → reverse charge
    note; EU B2C → OSS destination rate from tax_rates; non-EU → not taxable in DE.
- tax_mode_history with effective_from; resolver picks the strategy by finalization date.
  Admin settings page to schedule a switch (with a big warning and confirmation).
- Invoice lifecycle: draft → finalize() assigns gapless number (number_sequences, FOR UPDATE)
  in the same transaction, freezes seller+buyer snapshot + tax strategy, renders + stores PDF,
  status unpaid. Immutability enforced in code AND via a Postgres trigger.
- Credit notes (full/partial), own sequence, reference to the original invoice.
- Totals per line (net → tax half-up), summary grouped by tax rate; with kleinunternehmer the
  PDF shows only net = gross without a tax column.
- PDF (@react-pdf/renderer) with all applicable §14 UStG fields, Steuernummer, bank details,
  EPC/GiroCode QR for bank transfer, service periods per line. Storage behind an interface
  (local disk / S3-compatible).
- §19 threshold monitor: yearly net revenue (paid invoices, by service date per settings), limits
  configurable, admin dashboard widget + email to staff at 80% and 100%.
- Admin: invoice list/detail, manual invoices, finalize, cancel via credit note, resend, PDF.
- Client: invoice list + detail + PDF.
- API: GET /api/v1/invoices, GET /api/v1/invoices/{id}, GET /api/v1/invoices/{id}/pdf,
  POST /api/v1/invoices (draft, staff only), POST /api/v1/invoices/{id}/finalize. Documented.
Tests (concrete numbers): kleinunternehmer invoices; regular-vat DE/AT-B2B/AT-B2C/US cases;
strategy switch by effective date; rounding edge cases; 20 parallel finalizes → numbers 1..20
without gaps or duplicates; immutability trigger.
```

## Phase 4: Cart, checkout, orders

```
Implement cart → order → subscription.
- Server-side cart (cookie id → carts table), works for guests, merges on login.
- Checkout: login/register inline, billing address, accept AGB + Widerrufsbelehrung (store
  version + timestamp), choose payment method (bank transfer now; Stripe/PayPal in Phase 5),
  option "pay automatically" for recurring.
- On submit (one transaction): order + order_items → one subscription per billing cycle with
  subscription_items (price snapshot), services in `pending` for provisionable products,
  first invoice (prorated if aligning to a billing day is enabled) finalized.
- Admin: orders list/detail; accept, cancel, mark fraud. Per-product: auto-provision on payment
  vs. manual approval.
- API: POST /api/v1/orders, GET /api/v1/orders/{id}. Documented.
Tests: order totals = invoice totals; guest cart merge; trial → no first charge.
```

## Phase 5: Payments: Stripe + PayPal

```
Implement src/server/payments with a provider abstraction.
- interface PaymentGateway { id; createCheckout(invoice, opts); savePaymentMethod(customer);
  chargeSaved(method, invoice); refund(tx, amount); handleWebhook(req); capabilities }
- Our billing engine is the SOURCE OF TRUTH for subscriptions. Gateways only collect money.
- Stripe: Checkout Session / PaymentIntents for one-off, SetupIntent to save card + SEPA
  Direct Debit, off-session PaymentIntents for renewals, SCA handling (requires_action →
  email the customer a payment link). Webhooks: payment_intent.*, charge.refunded, setup_intent.*,
  charge.dispute.*.
- PayPal (REST, Orders v2): one-off checkout with capture. For recurring: PayPal vault
  (save payment method / payment tokens v3) if enabled on the account → charge like Stripe;
  fallback mode: PayPal Subscriptions API with a plan per price, mapped to our subscription via
  gateway_subscription_ref, our invoices marked paid from PAYMENT.SALE.COMPLETED webhooks.
  Make the mode a setting. Verify webhooks via PayPal's verify-webhook-signature endpoint.
- banktransfer: manual, bank details + GiroCode.
- applyPayment(invoiceId, amount, gateway, ref) in one transaction: transaction row, invoice
  status (partial/paid), overpayment → credit_ledger, emit "invoice.paid".
- Webhook routes /api/webhooks/stripe and /api/webhooks/paypal: verify, dedupe via processed_events.
- Client: manage payment methods (add/remove/default), pay open invoices, credit top-up.
- Admin: manual payment entry, refunds (credit note + refund tx), transaction list, disputes.
- Gateway credentials in settings (encrypted), sandbox/live toggle per gateway.
- API: GET /api/v1/transactions, POST /api/v1/invoices/{id}/payments (staff), documented.
Tests: partial payment, overpayment, duplicate webhook, refund, SCA-required renewal, PayPal
subscription-mode payment mapping (mocked HTTP).
```

## Phase 6: Subscriptions (Abos), recurring billing, dunning

```
Implement the subscription engine and pg-boss jobs.
- pg-boss in src/server/jobs; worker runs as a separate process (`pnpm worker`) / container.
- Subscription state machine (explicit transitions, illegal ones throw):
  trialing → active → past_due → (active | paused | cancelled) → ended. Services follow:
  past_due beyond grace → suspended, ended → terminated.
- Daily cron "billing:run" (idempotent, run markers per day):
  1) create renewal invoices N days before next_billing_at (default 14, per-product override),
     grouped per customer + currency, apply credit, finalize;
  2) on due date: auto-charge saved payment method if auto_charge (retry schedule d+0, d+3, d+7);
  3) advance the period only when paid;
  4) dunning: reminder at due+3, Mahnung at +10, suspend services at +14, end at +30 (configurable,
     optional Mahngebühr line);
  5) process cancel_at_period_end, trial ends, coupon expiry.
- Plan changes: upgrade/downgrade/quantity change with proration (immediate prorated invoice or
  credit; downgrade optionally at period end), pause/resume, cancel now / at period end.
- Admin: subscription detail (timeline of invoices, payments, state changes), actions for all of
  the above, change price/next billing date; "Jobs" page with queue state, failures, retry.
- Client: subscription list/detail, change plan with price preview, cancel.
- API: GET/POST /api/v1/subscriptions, GET /api/v1/subscriptions/{id}, POST …/{id}/cancel,
  …/{id}/pause, …/{id}/resume, …/{id}/change, GET …/{id}/preview-change. Documented with examples.
Tests: simulate 90 days with a fake clock: trial → active → failed charge → retries → dunning →
suspension → payment → reactivation; upgrade mid-cycle proration with concrete cents.
```

## Phase 7: Ticketing with M365 shared mailbox

```
Implement src/server/tickets with a pluggable channel; first channel: Microsoft Graph.
Setup (document in docs/m365-setup.md, admin does this in Entra/EXO):
- Entra app registration, application permissions Mail.ReadWrite + Mail.Send, certificate auth
  preferred (client secret supported). Restrict the app to the support mailbox(es) via
  Exchange Online RBAC for Applications (management scope) or an Application Access Policy.
  Include the exact PowerShell commands.
Inbound:
- Graph change notifications on /users/{mailbox}/mailFolders('inbox')/messages (webhook route
  /api/webhooks/msgraph with validationToken handshake + clientState check), auto-renew before
  expiry via a pg-boss cron. Notifications only enqueue a job; the job fetches the message.
- Delta query reconciliation every 5 min (stored deltaLink) so nothing is lost if notifications fail.
- Threading: ticket number in subject "[TKT-00042]", plus In-Reply-To/References against stored
  internet_message_ids, fallback conversationId. No match → new ticket.
- Customer matching by sender address against customer_contacts; unknown sender → ticket without
  customer, flagged for staff.
- Strip quoted history/signatures for display (keep original HTML stored), sanitize HTML,
  download attachments to storage (size limit setting), inline images via cid.
- Loop protection: ignore Auto-Submitted ≠ no, X-Auto-Response-Suppress, our own outbound
  messages, bounces; rate-limit auto replies per sender.
- After processing: mark read + move to folder "Processed" (create if missing).
Outbound:
- Staff replies send from the department's shared mailbox via Graph (reply to the original
  message to keep threading, else sendMail with proper headers), attachments (upload session
  for >3 MB). Store sent message ids.
- All system emails (invoices, reminders, welcome) also go out via Graph from a configurable
  sender mailbox: implement a MailTransport interface (graph | smtp) used by src/server/mail.
UI:
- Admin: ticket queue (filters: department, status, assignee, priority), detail with
  conversation, internal notes, canned replies, assign, merge tickets, link to customer/service.
- Client: open ticket via portal (creates ticket + sends confirmation mail), reply, close.
- API: GET/POST /api/v1/tickets, GET /api/v1/tickets/{id}, POST /api/v1/tickets/{id}/messages. Documented.
Tests: threading matcher, quote stripping, loop protection, notification → job → ticket flow with
mocked Graph responses.
```

## Phase 8: Provisioning (Proxmox first)

```
Implement src/server/provisioning.
- interface ProvisioningModule { id; configSchema; serverSchema; create; suspend; unsuspend;
  terminate; changePackage; getStatus; clientActions?; testConnection }
- Registry; products choose a module; servers belong to a module type.
- Module calls always run as pg-boss jobs with retries + backoff, results on the service.
- Hooks from Phase 6: subscription paid/active → create; past_due grace → suspend; ended → terminate;
  plan change → changePackage.
- Proxmox VE module (API token): clone from template, cores/RAM/disk from config, cloud-init
  (hostname, SSH key, password, IPs from ip_pools), power actions, reinstall, VNC console,
  suspend = stop + lock, node selection by free capacity.
- IP pools (IPv4 + IPv6) with assignment/release, rDNS field.
- Client service page: status, IPs, credentials (reveal audited), power actions, reinstall.
- API: GET /api/v1/services, GET /api/v1/services/{id}, POST /api/v1/services/{id}/actions/{action}. Documented.
Tests: module contract tests with mocked Proxmox API.
```

## Phase 9: Client portal polish + notifications

```
- Client dashboard: active subscriptions/services, open invoices, open tickets, credit.
- Full DE/EN i18n (next-intl), German default, mobile-friendly, dark mode.
- DSGVO export (JSON + PDFs) and anonymization (keeping invoices for the retention period).
- Email templates (react-email, DE/EN) for: welcome, verify, order, invoice created, payment
  received, payment failed / action required, reminder, Mahnung, service active (link, no plaintext
  passwords), suspended, ended, trial ending, ticket reply. All logged in email_log; resend from admin.
- Internal event bus (invoice.paid, subscription.renewed, ticket.created, …) feeding mail + webhooks.
```

## Phase 10: Admin reports, outbound webhooks, API completion

```
- Dashboard: MRR, ARR, revenue per month, churn, open receivables, upcoming renewals, failed jobs,
  §19 threshold widget.
- Exports: invoices/credit notes CSV, DATEV EXTF booking export per month.
- Outbound webhooks: endpoints with event selection, HMAC-SHA256 signature header, retries with
  backoff, delivery log + manual redelivery. Document all event payloads in OpenAPI (webhooks section).
- API completion pass: every resource has list/get (+ create/update where sensible), consistent
  cursor pagination, filtering, `Idempotency-Key` header support on POST, rate limiting with
  RateLimit headers, RFC 9457 errors. Fill OpenAPI info: Markdown guides for authentication,
  pagination, idempotency, errors, webhooks, changelog. Add code samples to Scalar (curl, JS, PHP).
- CI step: generate spec, lint it with Redocly CLI or Spectral, fail on undocumented routes
  (test that enumerates app/api/v1/** and checks the registry).
```

## Phase 11: Hardening & deploy

```
- Security review: authz test enumerating all server actions/routes, rate limiting on auth +
  checkout + API, CSP, secure cookies, dependency audit.
- Backups doc: pg_dump schedule, storage backup, APP_ENCRYPTION_KEY rotation.
- Observability: pino structured logs, /api/health, error reporting hook.
- Dokploy: app + worker + Postgres, migrations on deploy, .env.example documented.
- Playwright e2e: register → order VPS (monthly Abo) → pay with Stripe test card → service active →
  invoice PDF with §19 note → renewal after fake-clock advance → ticket via portal.
```

## Later (not needed as Kleinunternehmer)

- E-invoicing output (XRechnung / ZUGFeRD): Kleinunternehmer are exempt from the obligation to
  issue e-invoices, but must be able to **receive** them (that's an inbox issue, not this panel).
  Keep invoice data structured so it can be added when you switch to regular VAT.

---

## Decisions to make before Phase 3

- Invoice number format and whether it resets yearly.
- Dunning timings + whether to charge Mahngebühren.
- PayPal recurring mode: check whether vaulting is enabled on your PayPal business account; otherwise the subscriptions fallback is used.
- Which M365 shared mailbox(es) map to which ticket departments.
- Have your Steuerberater check a sample invoice before go-live.
