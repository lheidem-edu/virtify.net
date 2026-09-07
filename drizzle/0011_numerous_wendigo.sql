CREATE TYPE "public"."legal_kind" AS ENUM('terms', 'privacy', 'imprint');--> statement-breakpoint
CREATE TYPE "public"."legal_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "legal_document" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "legal_kind" NOT NULL,
	"version" integer NOT NULL,
	"status" "legal_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"eyebrow" text,
	"intro" text,
	"effective_from" timestamp,
	"published_at" timestamp,
	"announced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_section" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text,
	"title" text NOT NULL,
	"variant" text DEFAULT 'paren' NOT NULL,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"site_name" text NOT NULL,
	"site_url" text NOT NULL,
	"tagline" text NOT NULL,
	"description" text NOT NULL,
	"operator_name" text NOT NULL,
	"operator_street" text NOT NULL,
	"operator_city" text NOT NULL,
	"operator_country" text NOT NULL,
	"operator_email" text NOT NULL,
	"operator_vat_id" text NOT NULL,
	"operator_phone" text NOT NULL,
	"bank_name" text NOT NULL,
	"bank_iban" text NOT NULL,
	"bank_bic" text NOT NULL,
	"log_retention_days" integer NOT NULL,
	"payment_term_days" integer NOT NULL,
	"data_retrieval_days" integer NOT NULL,
	"security_maintenance_notice_hours" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_section" ADD CONSTRAINT "legal_section_document_id_legal_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_document_kind_idx" ON "legal_document" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "legal_section_document_id_idx" ON "legal_section" USING btree ("document_id");