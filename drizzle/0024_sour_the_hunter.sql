CREATE TYPE "public"."domain_event_status" AS ENUM('pending', 'dispatched', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'unknown', 'abandoned');--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"customer_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "domain_event_status" DEFAULT 'pending' NOT NULL,
	"dispatched_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" text PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_id" text,
	"customer_id" text,
	"entity_type" text,
	"entity_id" text,
	"to_email" text NOT NULL,
	"to_name" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp,
	"claimed_at" timestamp,
	"subject" text,
	"body_text" text,
	"sent_at" timestamp,
	"message_id" text,
	"transport" text,
	"last_error" text,
	"resend_count" integer DEFAULT 0 NOT NULL,
	"resend_of_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_event_id_domain_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_dedupe_idx" ON "domain_event" USING btree ("type","dedupe_key");--> statement-breakpoint
CREATE INDEX "domain_event_pending_idx" ON "domain_event" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "domain_event_customer_id_idx" ON "domain_event" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "domain_event_type_idx" ON "domain_event" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "email_log_dedupe_idx" ON "email_log" USING btree ("template","to_email","dedupe_key");--> statement-breakpoint
CREATE INDEX "email_log_runnable_idx" ON "email_log" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "email_log_customer_id_idx" ON "email_log" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "email_log_entity_idx" ON "email_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "email_log_event_id_idx" ON "email_log" USING btree ("event_id");