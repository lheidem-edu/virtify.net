CREATE TABLE "credit_note" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"recipient" text,
	"buyer_reference" text,
	"buyer_name" text,
	"buyer_street" text,
	"buyer_postal_code" text,
	"buyer_city" text,
	"buyer_country" text,
	"buyer_vat_id" text,
	"buyer_email" text,
	"buyer_customer_number" integer,
	"seller_name" text,
	"seller_street" text,
	"seller_city" text,
	"seller_country" text,
	"seller_email" text,
	"seller_phone" text,
	"seller_vat_id" text,
	"seller_tax_number" text,
	"seller_bank_name" text,
	"seller_iban" text,
	"seller_bic" text,
	"tax_strategy" text,
	"tax_note" text,
	"pdf_key" text,
	"pdf_sha256" text,
	"pdf_bytes" integer,
	"pdf_rendered_at" timestamp,
	"net_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"gross_cents" integer NOT NULL,
	"issued_at" timestamp NOT NULL,
	"service_period_start" timestamp,
	"service_period_end" timestamp,
	"sent_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "credit_note_item" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_note_id" text NOT NULL,
	"invoice_item_id" text,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_code" text DEFAULT 'MON' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"detail" text,
	"service_period_start" timestamp,
	"service_period_end" timestamp,
	"tax_strategy" text NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"tax_category" text NOT NULL,
	"tax_rule" text NOT NULL,
	"net_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_notice" (
	"id" text PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"metric" text NOT NULL,
	"level" integer NOT NULL,
	"net_cents" integer NOT NULL,
	"limit_cents" integer NOT NULL,
	"notified_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_mode_history" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy" text NOT NULL,
	"effective_from" timestamp NOT NULL,
	"note" text,
	"created_by_staff_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT "invoice_cancels_invoice_id_invoice_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DEFAULT 'draft'::text;--> statement-breakpoint
--> Phase 3: "issued" is called "unpaid" from here on — docs/BUILD_PLAN.md's
--> lifecycle is draft -> unpaid -> paid / cancelled. Renamed while the column
--> is text, because the cast back would reject a value the new enum lacks.
UPDATE "invoice" SET "status" = 'unpaid' WHERE "status" = 'issued';--> statement-breakpoint
DROP TYPE "public"."invoice_status";--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'unpaid', 'paid', 'cancelled');--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DATA TYPE "public"."invoice_status" USING "status"::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "currency" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "buyer_customer_number" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_name" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_street" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_city" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_country" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_email" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_phone" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_vat_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_tax_number" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_bank_name" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_iban" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "seller_bic" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "tax_strategy" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "tax_note" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "pdf_key" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "pdf_sha256" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "pdf_bytes" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "pdf_rendered_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "net_cents" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "tax_cents" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "gross_cents" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "credited_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "service_period_start" timestamp;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "service_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "tax_strategy" text;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "tax_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "tax_category" text;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "tax_rule" text;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "net_cents" integer;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "operator_tax_number" text;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "kleinunternehmer_previous_limit_cents" integer DEFAULT 2500000 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "kleinunternehmer_current_limit_cents" integer DEFAULT 10000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "revenue_basis" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_item" ADD CONSTRAINT "credit_note_item_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_item" ADD CONSTRAINT "credit_note_item_invoice_item_id_invoice_item_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_mode_history" ADD CONSTRAINT "tax_mode_history_created_by_staff_id_staff_user_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_invoice_id_idx" ON "credit_note" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_note_customer_id_idx" ON "credit_note" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "credit_note_issued_at_idx" ON "credit_note" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "credit_note_item_credit_note_id_idx" ON "credit_note_item" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_item_position_idx" ON "credit_note_item" USING btree ("credit_note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_notice_year_metric_level_idx" ON "revenue_notice" USING btree ("year","metric","level");--> statement-breakpoint
CREATE INDEX "revenue_notice_year_idx" ON "revenue_notice" USING btree ("year");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_mode_history_effective_from_idx" ON "tax_mode_history" USING btree ("effective_from");--> statement-breakpoint
CREATE INDEX "invoice_customer_id_idx" ON "invoice" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoice_status_idx" ON "invoice" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoice_issued_at_idx" ON "invoice" USING btree ("issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_item_position_idx" ON "invoice_item" USING btree ("invoice_id","position");--> statement-breakpoint
--============================================================================
-- Phase 3 data migration
--
-- Three things happen here, in order: the country column is put into ISO
-- codes so the tax determination can read it, every finalized invoice gets
-- the tax snapshot and the totals it would have been given today, and the
-- corrections that were kept as negative invoices in the RE- series become
-- credit notes of their own.
--============================================================================

-- Accounts created before the ISO validation carry the country as a word.
-- The tax determination refuses to finalize without a code, so this is not
-- cosmetic. Anything it cannot place is left alone and will say so loudly.
UPDATE "customer"
SET "country" = CASE
        WHEN upper(trim("country")) IN ('DEUTSCHLAND', 'GERMANY', 'DE') THEN 'DE'
        WHEN upper(trim("country")) IN ('ÖSTERREICH', 'OESTERREICH', 'AUSTRIA', 'AT') THEN 'AT'
        WHEN upper(trim("country")) IN ('SCHWEIZ', 'SWITZERLAND', 'CH') THEN 'CH'
        WHEN upper(trim("country")) IN ('NIEDERLANDE', 'NETHERLANDS', 'NL') THEN 'NL'
        WHEN upper(trim("country")) IN ('FRANKREICH', 'FRANCE', 'FR') THEN 'FR'
        WHEN length(trim("country")) = 2 THEN upper(trim("country"))
        ELSE "country"
    END
WHERE "country" IS NOT NULL AND trim("country") <> '';--> statement-breakpoint

-- Every invoice that was ever issued was issued under § 19 UStG, so that is
-- the snapshot it gets: 0 %, category E, and the sentence the strategy
-- prints. The seller block comes from the settings row, which is the address
-- those documents were rendered with.
UPDATE "invoice" AS i
SET "tax_strategy" = 'kleinunternehmer',
    "tax_note" = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    "net_cents" = coalesce((
        SELECT sum(it."quantity" * it."unit_price_cents")
        FROM "invoice_item" it WHERE it."invoice_id" = i."id"), 0),
    "tax_cents" = 0,
    "gross_cents" = coalesce((
        SELECT sum(it."quantity" * it."unit_price_cents")
        FROM "invoice_item" it WHERE it."invoice_id" = i."id"), 0),
    "buyer_customer_number" = cu."customer_number",
    "seller_name" = ss."operator_name",
    "seller_street" = ss."operator_street",
    "seller_city" = ss."operator_city",
    "seller_country" = ss."operator_country",
    "seller_email" = ss."operator_email",
    "seller_phone" = ss."operator_phone",
    "seller_vat_id" = ss."operator_vat_id",
    "seller_tax_number" = ss."operator_tax_number",
    "seller_bank_name" = ss."bank_name",
    "seller_iban" = ss."bank_iban",
    "seller_bic" = ss."bank_bic"
FROM "customer" cu
LEFT JOIN "site_setting" ss ON ss."id" = 'singleton'
WHERE cu."id" = i."customer_id" AND i."number" IS NOT NULL;--> statement-breakpoint

UPDATE "invoice_item" AS it
SET "tax_strategy" = 'kleinunternehmer',
    "tax_rate_bp" = 0,
    "tax_category" = 'E',
    "tax_rule" = 'kleinunternehmer',
    "net_cents" = it."quantity" * it."unit_price_cents"
FROM "invoice" i
WHERE i."id" = it."invoice_id" AND i."number" IS NOT NULL;--> statement-breakpoint

-- The corrections become credit notes. They keep the RE- number they were
-- issued under: a document the customer holds cannot be renumbered, so the
-- RE- series has two holes that are accounted for by two RK-less credit
-- notes, and every number ever handed out is still attributable. New
-- corrections take RK- numbers from their own counter.
--
-- The id is derived from the invoice's own ULID rather than generated, so
-- the mapping stays visible: invoice_01M1W0CRCR… becomes
-- creditnote_01M1W0CRCR….
INSERT INTO "credit_note" (
    "id", "invoice_id", "customer_id", "number", "kind", "currency",
    "recipient", "buyer_reference", "buyer_name", "buyer_street",
    "buyer_postal_code", "buyer_city", "buyer_country", "buyer_vat_id",
    "buyer_email", "buyer_customer_number",
    "seller_name", "seller_street", "seller_city", "seller_country",
    "seller_email", "seller_phone", "seller_vat_id", "seller_tax_number",
    "seller_bank_name", "seller_iban", "seller_bic",
    "tax_strategy", "tax_note", "net_cents", "tax_cents", "gross_cents",
    "issued_at", "service_period_start", "service_period_end", "note",
    "created_at", "updated_at"
)
SELECT 'creditnote_' || substring(c."id" FROM 9),
       c."cancels_invoice_id", c."customer_id", c."number", 'full', c."currency",
       c."recipient", c."buyer_reference", c."buyer_name", c."buyer_street",
       c."buyer_postal_code", c."buyer_city", c."buyer_country", c."buyer_vat_id",
       c."buyer_email", c."buyer_customer_number",
       c."seller_name", c."seller_street", c."seller_city", c."seller_country",
       c."seller_email", c."seller_phone", c."seller_vat_id", c."seller_tax_number",
       c."seller_bank_name", c."seller_iban", c."seller_bic",
       'kleinunternehmer', 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
       -- A correction of this vintage always reversed the whole invoice, so
       -- its totals are the original's. Taking them from the original rather
       -- than negating the correction's own is what keeps the pair exact
       -- whichever way the old code carried the sign.
       coalesce(o."net_cents", 0), 0, coalesce(o."gross_cents", 0),
       coalesce(c."issued_at", c."created_at"),
       c."service_period_start", c."service_period_end", c."note",
       c."created_at", c."updated_at"
FROM "invoice" c
JOIN "invoice" o ON o."id" = c."cancels_invoice_id"
WHERE c."cancels_invoice_id" IS NOT NULL;--> statement-breakpoint

-- A credit note's amounts are positive (UNTDID 1001 type 381); the old
-- corrections carried the reversal on the quantity, so it is taken off again.
INSERT INTO "credit_note_item" (
    "id", "credit_note_id", "invoice_item_id", "position", "description",
    "quantity", "unit_code", "unit_price_cents", "detail",
    "service_period_start", "service_period_end",
    "tax_strategy", "tax_rate_bp", "tax_category", "tax_rule", "net_cents"
)
SELECT 'creditnoteitem_' || substring(it."id" FROM 13),
       'creditnote_' || substring(c."id" FROM 9),
       orig."id",
       it."position", it."description",
       -- The quantity and the price come from the line being reversed, not
       -- from the reversal: the old code put the minus sometimes on the
       -- quantity and sometimes on the price, and abs() on either would turn
       -- a genuinely negative line of the original into a charge.
       coalesce(orig."quantity", abs(it."quantity")),
       it."unit_code",
       coalesce(orig."unit_price_cents", abs(it."unit_price_cents")),
       it."detail",
       it."service_period_start", it."service_period_end",
       'kleinunternehmer', 0, 'E', 'kleinunternehmer',
       coalesce(
           orig."quantity" * orig."unit_price_cents",
           abs(it."quantity" * it."unit_price_cents")
       )
FROM "invoice" c
JOIN "invoice_item" it ON it."invoice_id" = c."id"
LEFT JOIN "invoice_item" orig
       ON orig."invoice_id" = c."cancels_invoice_id"
      AND orig."position" = it."position"
WHERE c."cancels_invoice_id" IS NOT NULL;--> statement-breakpoint

UPDATE "invoice" o
SET "credited_cents" = cn."gross_cents",
    "cancelled_at" = coalesce(o."cancelled_at", cn."issued_at"),
    "status" = 'cancelled'
FROM "credit_note" cn
WHERE cn."invoice_id" = o."id";--> statement-breakpoint

DELETE FROM "invoice_item"
WHERE "invoice_id" IN (SELECT "id" FROM "invoice" WHERE "cancels_invoice_id" IS NOT NULL);--> statement-breakpoint

DELETE FROM "invoice" WHERE "cancels_invoice_id" IS NOT NULL;--> statement-breakpoint

-- The strategy in force since the beginning. The resolver falls back to
-- § 19 with no row at all, but a history that starts at the epoch is what
-- makes the admin page able to say since when.
INSERT INTO "tax_mode_history" ("id", "strategy", "effective_from", "note")
VALUES (
    'taxmode_00000000000000000000000000',
    'kleinunternehmer',
    TIMESTAMP '1970-01-01 00:00:00',
    'Ausgangszustand: Kleinunternehmerregelung nach § 19 UStG.'
)
ON CONFLICT DO NOTHING;
