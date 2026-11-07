CREATE TYPE "public"."audit_actor_type" AS ENUM('staff', 'customer', 'api', 'system');--> statement-breakpoint
CREATE TYPE "public"."customer_contact_role" AS ENUM('owner', 'contact');--> statement-breakpoint
CREATE TYPE "public"."customer_kind" AS ENUM('company', 'private');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"customer_id" text,
	"staff_user_id" text,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_key_one_owner" CHECK (num_nonnulls("api_key"."customer_id", "api_key"."staff_user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_number" integer NOT NULL,
	"kind" "customer_kind" DEFAULT 'private' NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"street" text,
	"postal_code" text,
	"city" text,
	"country" text,
	"vat_id" text,
	"vat_id_validated_at" timestamp,
	"phone" text,
	"buyer_reference" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"language" text DEFAULT 'de' NOT NULL,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"stripe_customer_id" text,
	"paypal_customer_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customer_customer_number_unique" UNIQUE("customer_number"),
	CONSTRAINT "customer_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "customer_paypal_customer_id_unique" UNIQUE("paypal_customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_contact" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "customer_contact_role" DEFAULT 'contact' NOT NULL,
	"email" text NOT NULL,
	"can_billing" boolean DEFAULT true NOT NULL,
	"can_technical" boolean DEFAULT true NOT NULL,
	"can_tickets" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_role" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_role_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "staff_role_assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "user_customer_number_unique";--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "user_stripe_customer_id_unique";--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "user_paypal_customer_id_unique";--> statement-breakpoint
ALTER TABLE "contract" DROP CONSTRAINT "contract_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice" DROP CONSTRAINT "invoice_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "offer" DROP CONSTRAINT "offer_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "payment_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_method" DROP CONSTRAINT "payment_method_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_setup" DROP CONSTRAINT "payment_setup_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "payment_method_user_id_idx";--> statement-breakpoint
ALTER TABLE "contract" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "payment_method" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "payment_setup" ADD COLUMN "customer_id" text;--> statement-breakpoint
--> statement-breakpoint
/*
 * Split the login from the billing account.
 *
 * Until now a `user` row was both: the credentials and the master data every
 * invoice was addressed to. Each one becomes a `customer` plus an owner
 * `customer_contact`, and everything that was addressed to a user is
 * re-addressed to that customer.
 *
 * The new ids reuse the user's ULID after their own prefix, so the mapping is
 * a substring rather than a lookup table and a customer still sorts by the
 * moment its account was opened.
 */
INSERT INTO "customer" (
    "id", "customer_number", "kind", "name", "company", "street", "postal_code",
    "city", "country", "vat_id", "phone", "buyer_reference",
    "stripe_customer_id", "paypal_customer_id", "created_at", "updated_at"
)
SELECT
    'customer_' || substring(u."id" from 6),
    -- Accounts created before customer numbers existed get one now, counted
    -- on from the highest in use so the two series never overlap.
    coalesce(
        u."customer_number",
        (SELECT coalesce(max(u2."customer_number"), 10000) FROM "user" u2)
            + (SELECT count(*) FROM "user" u3
               WHERE u3."customer_number" IS NULL AND u3."id" <= u."id")
    ),
    CASE WHEN coalesce(u."company", '') <> '' THEN 'company' ELSE 'private' END::"public"."customer_kind",
    u."name",
    u."company",
    u."street",
    u."postal_code",
    u."city",
    u."country",
    u."vat_id",
    u."phone",
    u."buyer_reference",
    u."stripe_customer_id",
    u."paypal_customer_id",
    u."created_at",
    u."updated_at"
FROM "user" u;--> statement-breakpoint
INSERT INTO "customer_contact" (
    "id", "customer_id", "user_id", "role", "email", "created_at", "updated_at"
)
SELECT
    'customercontact_' || substring(u."id" from 6),
    'customer_' || substring(u."id" from 6),
    u."id",
    'owner',
    u."email",
    u."created_at",
    u."updated_at"
FROM "user" u;--> statement-breakpoint
-- Keep the sign-up counter ahead of every number now in use.
INSERT INTO "document_counter" ("scope", "value")
VALUES ('customer', (SELECT coalesce(max("customer_number"), 10000) FROM "customer"))
ON CONFLICT ("scope") DO UPDATE
    SET "value" = GREATEST("document_counter"."value", EXCLUDED."value");--> statement-breakpoint
UPDATE "contract" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
UPDATE "invoice" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
UPDATE "offer" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
UPDATE "payment" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
UPDATE "payment_method" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
UPDATE "payment_setup" SET "customer_id" = 'customer_' || substring("user_id" from 6);--> statement-breakpoint
ALTER TABLE "contract" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "offer" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_method" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_setup" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_assignment" ADD CONSTRAINT "staff_role_assignment_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_assignment" ADD CONSTRAINT "staff_role_assignment_role_id_staff_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."staff_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_customer_id_idx" ON "api_key" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "api_key_staff_user_id_idx" ON "api_key" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "customer_status_idx" ON "customer" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customer_email_search_idx" ON "customer" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_customer_user_idx" ON "customer_contact" USING btree ("customer_id","user_id");--> statement-breakpoint
CREATE INDEX "customer_contact_user_id_idx" ON "customer_contact" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_contact_email_idx" ON "customer_contact" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_role_assignment_user_role_idx" ON "staff_role_assignment" USING btree ("staff_user_id","role_id");--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_setup" ADD CONSTRAINT "payment_setup_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_method_customer_id_idx" ON "payment_method" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "contract" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "invoice" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "offer" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "payment" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "payment_method" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "payment_setup" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "company";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "street";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "postal_code";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "city";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "vat_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "buyer_reference";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "customer_number";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "paypal_customer_id";--> statement-breakpoint
/*
 * RBAC arrives with every permission already granted to everyone who had the
 * panel before it. Anything else would lock the operator out of their own
 * installation the moment this migration runs.
 */
INSERT INTO "staff_role" ("id", "name", "description", "permissions", "is_system")
VALUES (
    'staffrole_01M6SMFSAEJF3W83MRWBYQ3GMK',
    'Super Admin',
    'Darf alles. Kann nicht gelöscht oder eingeschränkt werden.',
    ARRAY['*'],
    true
)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "staff_role_assignment" ("id", "staff_user_id", "role_id")
SELECT
    'staffroleassignment_' || substring(su."id" from 11),
    su."id",
    'staffrole_01M6SMFSAEJF3W83MRWBYQ3GMK'
FROM "staff_user" su
ON CONFLICT DO NOTHING;
