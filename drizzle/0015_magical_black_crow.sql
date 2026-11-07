CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'quarterly', 'semiannual', 'annual', 'biennial', 'onetime');--> statement-breakpoint
CREATE TYPE "public"."config_option_type" AS ENUM('select', 'checkbox', 'quantity');--> statement-breakpoint
CREATE TYPE "public"."coupon_duration" AS ENUM('once', 'repeating', 'forever');--> statement-breakpoint
CREATE TYPE "public"."coupon_kind" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'hidden', 'retired');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('vps', 'webhosting', 'gameserver', 'domain', 'subscription', 'other');--> statement-breakpoint
CREATE TABLE "config_option" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "config_option_type" DEFAULT 'select' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"max_quantity" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_option_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"value_id" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"setup_fee_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_option_value" (
	"id" text PRIMARY KEY NOT NULL,
	"option_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"kind" "coupon_kind" NOT NULL,
	"percent_basis_points" integer,
	"amount_cents" integer,
	"currency" text,
	"duration" "coupon_duration" DEFAULT 'once' NOT NULL,
	"duration_periods" integer,
	"applies_to_setup_fee" boolean DEFAULT false NOT NULL,
	"product_ids" text[] DEFAULT '{}' NOT NULL,
	"cycles" text[] DEFAULT '{}' NOT NULL,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "product_type" DEFAULT 'other' NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"tagline" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"module" text DEFAULT 'none' NOT NULL,
	"module_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_quantity" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_group" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_group_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"setup_fee_cents" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_option" ADD CONSTRAINT "config_option_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_option_pricing" ADD CONSTRAINT "config_option_pricing_value_id_config_option_value_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."config_option_value"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_option_value" ADD CONSTRAINT "config_option_value_option_id_config_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."config_option"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_group_id_product_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD CONSTRAINT "product_pricing_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_option_product_id_idx" ON "config_option" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_option_pricing_cell_idx" ON "config_option_pricing" USING btree ("value_id","cycle","currency");--> statement-breakpoint
CREATE INDEX "config_option_value_option_id_idx" ON "config_option_value" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "coupon_active_idx" ON "coupon" USING btree ("active");--> statement-breakpoint
CREATE INDEX "product_group_id_idx" ON "product" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "product_status_idx" ON "product" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_group_sort_idx" ON "product_group" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_pricing_cell_idx" ON "product_pricing" USING btree ("product_id","cycle","currency");