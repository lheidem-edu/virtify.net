ALTER TABLE "invoice_item" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "offer_item" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "customer_number" integer;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_customer_number_unique" UNIQUE("customer_number");