CREATE TYPE "public"."credit_ledger_kind" AS ENUM('overpayment', 'topup', 'applied', 'refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'won', 'lost', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."gateway_mode" AS ENUM('sandbox', 'live');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('charge', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('invoice', 'topup');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'partial' BEFORE 'paid';--> statement-breakpoint
ALTER TYPE "public"."payment_provider" ADD VALUE 'banktransfer';--> statement-breakpoint
ALTER TYPE "public"."payment_provider" ADD VALUE 'credit';--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"kind" "credit_ledger_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"payment_id" text,
	"invoice_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_dispute" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"reason" text,
	"respond_by" timestamp,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_provider_ref_unique" UNIQUE("provider_ref")
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" "gateway_mode" DEFAULT 'sandbox' NOT NULL,
	"credentials" text,
	"paypal_recurring_mode" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"paypal_product_id" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_plan_plan_key_unique" UNIQUE("plan_key")
);
--> statement-breakpoint
ALTER TABLE "payment" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "paid_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "kind" "payment_kind" DEFAULT 'charge' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "purpose" "payment_purpose" DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "parent_payment_id" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "payment_method" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD COLUMN "handled_at" timestamp;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_customer_id_idx" ON "credit_ledger" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_payment_kind_idx" ON "credit_ledger" USING btree ("payment_id","kind") WHERE "payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_dispute_payment_id_idx" ON "payment_dispute" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_parent_payment_id_payment_id_fk" FOREIGN KEY ("parent_payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_customer_id_idx" ON "payment" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payment_status_idx" ON "payment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_parent_idx" ON "payment" USING btree ("parent_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_one_default_idx" ON "payment_method" USING btree ("customer_id") WHERE "is_default" and "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_event_received_at_idx" ON "webhook_event" USING btree ("received_at");--> statement-breakpoint

--============================================================================
-- `paid_cents` joins the short list of columns a finalized invoice may still
-- change.
--
-- Rule 3 allows exactly the facts that are *about* the invoice rather than
-- statements *on* it: whether it has been paid, how much a correction took
-- back, when a copy went out. How much of it has actually been received is
-- the same kind of fact — nothing printed on the document moves, and the
-- figure is derived from the `payment` rows, which are the real record.
--
-- Migration 0017 said it deliberately compares "the whole row minus these",
-- so that a column added later is immutable by default. This is that
-- mechanism working as intended: the column had to be named here, in a
-- migration of its own, instead of silently inheriting permission.
--============================================================================

CREATE OR REPLACE FUNCTION "invoice_is_immutable"() RETURNS trigger AS $$
DECLARE
    mutable text[] := ARRAY[
        'status', 'paid_at', 'cancelled_at', 'sent_at',
        'credited_cents', 'paid_cents', 'updated_at',
        'pdf_key', 'pdf_sha256', 'pdf_bytes', 'pdf_rendered_at'
    ];
BEGIN
    -- A finalized invoice can never become a draft again. Without this the
    -- status column, being mutable, is the key to every other lock.
    IF OLD."status" <> 'draft' AND NEW."status" = 'draft' THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und kann kein Entwurf mehr werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" = 'draft' THEN
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION
            'Rechnung % ist ausgestellt und darf nicht mehr geändert werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."pdf_key" IS NOT NULL AND NEW."pdf_key" IS DISTINCT FROM OLD."pdf_key" THEN
        RAISE EXCEPTION
            'Das gespeicherte Dokument der Rechnung % darf nicht ersetzt werden',
            coalesce(OLD."number", OLD."id")
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

--============================================================================
-- The invariants `applyPayment` maintains, stated where everything that
-- writes to these tables has to pass — which is the same argument migration
-- 0017 makes for the immutability triggers.
--============================================================================

ALTER TABLE "payment"
    ADD CONSTRAINT "payment_amount_is_positive"
    CHECK ("amount_cents" >= 0 AND "refunded_cents" >= 0
           AND "refunded_cents" <= "amount_cents");--> statement-breakpoint

-- A refund reverses a charge, and only a refund has one to reverse.
ALTER TABLE "payment"
    ADD CONSTRAINT "payment_refund_has_a_parent"
    CHECK (("kind" = 'refund') = ("parent_payment_id" IS NOT NULL));--> statement-breakpoint

-- A top-up is the only payment without a document behind it.
ALTER TABLE "payment"
    ADD CONSTRAINT "payment_invoice_unless_topup"
    CHECK ("purpose" = 'topup' OR "invoice_id" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_paid_cents_is_positive"
    CHECK ("paid_cents" >= 0);
