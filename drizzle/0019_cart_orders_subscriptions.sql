CREATE TYPE "public"."provisioning_mode" AS ENUM('manual', 'auto_on_payment');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('open', 'ordered', 'merged', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'active', 'cancelled', 'fraud');--> statement-breakpoint
CREATE TYPE "public"."payment_option" AS ENUM('bank_transfer', 'stripe', 'paypal');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('pending', 'provisioning', 'active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'paused', 'cancelled', 'ended');--> statement-breakpoint
CREATE TABLE "cart" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"customer_id" text,
	"status" "cart_status" DEFAULT 'open' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"merged_into_cart_id" text,
	"order_id" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cart_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cart_item" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"product_id" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"selections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coupon_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"number" text NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"invoice_id" text,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"payment_option" "payment_option" DEFAULT 'bank_transfer' NOT NULL,
	"auto_charge" boolean DEFAULT false NOT NULL,
	"terms_document_id" text,
	"terms_version" integer,
	"terms_label" text,
	"terms_accepted_at" timestamp NOT NULL,
	"withdrawal_accepted_at" timestamp,
	"immediate_start_requested_at" timestamp,
	"is_consumer" boolean DEFAULT true NOT NULL,
	"ip" text,
	"user_agent" text,
	"placed_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp,
	"cancelled_at" timestamp,
	"decision_reason" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "order_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"setup_fee_cents" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"recurring_gross_cents" integer DEFAULT 0 NOT NULL,
	"recurring_discount_cents" integer DEFAULT 0 NOT NULL,
	"first_period_cents" integer DEFAULT 0 NOT NULL,
	"renewal_cents" integer DEFAULT 0 NOT NULL,
	"setup_gross_cents" integer DEFAULT 0 NOT NULL,
	"setup_discount_cents" integer DEFAULT 0 NOT NULL,
	"setup_cents" integer DEFAULT 0 NOT NULL,
	"due_today_cents" integer DEFAULT 0 NOT NULL,
	"coupon_id" text,
	"coupon_code" text,
	"discount_periods" integer,
	"selections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_item_id" text,
	"product_id" text NOT NULL,
	"status" "service_status" DEFAULT 'pending' NOT NULL,
	"label" text NOT NULL,
	"module" text DEFAULT 'none' NOT NULL,
	"provisioning_mode" "provisioning_mode" DEFAULT 'manual' NOT NULL,
	"module_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"activated_at" timestamp,
	"suspended_at" timestamp,
	"terminated_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"order_id" text,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"current_period_start" timestamp NOT NULL,
	"current_period_end" timestamp,
	"next_billing_at" timestamp,
	"trial_ends_at" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"auto_charge" boolean DEFAULT false NOT NULL,
	"payment_method_id" text,
	"gateway" text,
	"gateway_subscription_ref" text,
	"coupon_id" text,
	"coupon_code" text,
	"discount_periods_remaining" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_at" timestamp,
	"ended_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_item" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"product_id" text NOT NULL,
	"order_item_id" text,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"setup_fee_cents" integer DEFAULT 0 NOT NULL,
	"recurring_gross_cents" integer DEFAULT 0 NOT NULL,
	"selections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "provisioning_mode" "provisioning_mode" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "billing_anchor_day" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cart" ADD CONSTRAINT "cart_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_cart_id_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."cart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_coupon_id_coupon_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupon"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_subscription_item_id_subscription_item_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_payment_method_id_payment_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_coupon_id_coupon_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupon"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD CONSTRAINT "subscription_item_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD CONSTRAINT "subscription_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD CONSTRAINT "subscription_item_order_item_id_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_customer_id_idx" ON "cart" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "cart_status_idx" ON "cart" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cart_item_cart_id_idx" ON "cart_item" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "order_customer_id_idx" ON "order" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "order_status_idx" ON "order" USING btree ("status");--> statement-breakpoint
CREATE INDEX "order_placed_at_idx" ON "order" USING btree ("placed_at");--> statement-breakpoint
CREATE INDEX "order_item_order_id_idx" ON "order_item" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_position_idx" ON "order_item" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "service_customer_id_idx" ON "service" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "service_status_idx" ON "service" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_subscription_item_id_idx" ON "service" USING btree ("subscription_item_id");--> statement-breakpoint
CREATE INDEX "subscription_customer_id_idx" ON "subscription" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "subscription_status_idx" ON "subscription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscription_next_billing_at_idx" ON "subscription" USING btree ("next_billing_at");--> statement-breakpoint
CREATE INDEX "subscription_item_subscription_id_idx" ON "subscription_item" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_item_position_idx" ON "subscription_item" USING btree ("subscription_id","position");