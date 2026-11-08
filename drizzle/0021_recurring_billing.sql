--============================================================================
-- Phase 6 — the recurring run, and what stops it running twice
--
-- Everything added here exists to answer one question: a cron fires at three
-- in the morning, a worker is scaled to two replicas, a job times out and is
-- retried, and an operator presses "jetzt abrechnen" — what makes the
-- customer be invoiced once, charged once and dunned once?
--
-- Not the caller. These four unique indexes:
--
--   subscription_invoice (subscription_id, period_start, kind)
--       one invoice per subscription per period
--   invoice_collection   (invoice_id, offset_days)
--       one auto-charge per rung of the retry ladder
--   dunning_action       (invoice_id, level)
--       one reminder, one Mahnung, one suspension, one termination
--   billing_run          (run_day)
--       the cheap layer: it keeps a second cron pass off the database, and
--       it is the only one of the four an operator may deliberately bypass
--
-- No column is added to `invoice`: a column added there is immutable by
-- default (migration 0017), and nothing in this phase needs to write to a
-- finalized document. A Mahngebühr is therefore an invoice of its own, and
-- withdrawing it is a Rechnungskorrektur against that invoice.
--============================================================================

CREATE TYPE "public"."billing_run_status" AS ENUM('running', 'finished', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_collection_status" AS ENUM('claimed', 'succeeded', 'processing', 'requires_action', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."dunning_level" AS ENUM('reminder', 'mahnung', 'suspend', 'terminate');--> statement-breakpoint
CREATE TYPE "public"."subscription_change_effective" AS ENUM('immediately', 'period_end');--> statement-breakpoint
CREATE TYPE "public"."subscription_change_status" AS ENUM('pending', 'applied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscription_invoice_kind" AS ENUM('initial', 'renewal', 'change', 'dunning_fee');--> statement-breakpoint
CREATE TABLE "billing_run" (
	"id" text PRIMARY KEY NOT NULL,
	"run_day" text NOT NULL,
	"status" "billing_run_status" DEFAULT 'running' NOT NULL,
	"forced" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dunning_action" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"level" "dunning_level" NOT NULL,
	"due_at" timestamp NOT NULL,
	"acted_at" timestamp DEFAULT now() NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"fee_invoice_id" text,
	"fee_waived_at" timestamp,
	"notified" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_collection" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"offset_days" integer NOT NULL,
	"status" "invoice_collection_status" DEFAULT 'claimed' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"due_at" timestamp NOT NULL,
	"attempted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_change" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"subscription_item_id" text NOT NULL,
	"status" "subscription_change_status" DEFAULT 'pending' NOT NULL,
	"effective" "subscription_change_effective" NOT NULL,
	"direction" text NOT NULL,
	"product_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"selections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"recurring_gross_cents" integer NOT NULL,
	"proration_cents" integer DEFAULT 0 NOT NULL,
	"invoice_id" text,
	"apply_at" timestamp NOT NULL,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_event" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_label" text,
	"at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_invoice" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"kind" "subscription_invoice_kind" DEFAULT 'renewal' NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "renewal_lead_days" integer;--> statement-breakpoint
ALTER TABLE "invoice_item" ADD COLUMN "subscription_item_id" text;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "renewal_lead_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "collection_retry_days" integer[] DEFAULT '{0,3,7}' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "dunning_reminder_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "dunning_mahnung_days" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "dunning_suspend_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "dunning_terminate_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "dunning_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "past_due_at" timestamp;--> statement-breakpoint
ALTER TABLE "dunning_action" ADD CONSTRAINT "dunning_action_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_action" ADD CONSTRAINT "dunning_action_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_action" ADD CONSTRAINT "dunning_action_fee_invoice_id_invoice_id_fk" FOREIGN KEY ("fee_invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_collection" ADD CONSTRAINT "invoice_collection_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_change" ADD CONSTRAINT "subscription_change_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_change" ADD CONSTRAINT "subscription_change_subscription_item_id_subscription_item_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_change" ADD CONSTRAINT "subscription_change_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_change" ADD CONSTRAINT "subscription_change_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_run_day_idx" ON "billing_run" USING btree ("run_day");--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_action_level_idx" ON "dunning_action" USING btree ("invoice_id","level");--> statement-breakpoint
CREATE INDEX "dunning_action_customer_id_idx" ON "dunning_action" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_collection_rung_idx" ON "invoice_collection" USING btree ("invoice_id","offset_days");--> statement-breakpoint
CREATE INDEX "subscription_change_subscription_id_idx" ON "subscription_change" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_change_one_pending_idx" ON "subscription_change" USING btree ("subscription_item_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "subscription_event_subscription_id_idx" ON "subscription_event" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_period_idx" ON "subscription_invoice" USING btree ("subscription_id","period_start","kind");--> statement-breakpoint
CREATE INDEX "subscription_invoice_invoice_id_idx" ON "subscription_invoice" USING btree ("invoice_id");