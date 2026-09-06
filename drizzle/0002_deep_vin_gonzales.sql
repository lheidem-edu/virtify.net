ALTER TABLE "two_factor" ADD COLUMN "verified" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "failed_verification_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");