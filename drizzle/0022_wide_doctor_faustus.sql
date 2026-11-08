CREATE TYPE "public"."ticket_message_author" AS ENUM('customer', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."ticket_message_direction" AS ENUM('inbound', 'outbound', 'note');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'waiting', 'on_hold', 'closed');--> statement-breakpoint
CREATE TABLE "auto_reply_budget" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"window" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'msgraph' NOT NULL,
	"mailbox" text NOT NULL,
	"internet_message_id" text NOT NULL,
	"channel_message_id" text,
	"from_email" text,
	"subject" text,
	"received_at" timestamp,
	"attempts" integer DEFAULT 1 NOT NULL,
	"handled_at" timestamp,
	"outcome" text,
	"reason" text,
	"ticket_id" text,
	"ticket_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_channel_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"credentials" text,
	"processed_folder" text DEFAULT 'Processed' NOT NULL,
	"max_attachment_bytes" bigint DEFAULT 20971520 NOT NULL,
	"auto_reply_per_hour" integer DEFAULT 4 NOT NULL,
	"outbound_sender" text,
	"transport" text DEFAULT 'smtp' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_notification" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'msgraph' NOT NULL,
	"mailbox" text NOT NULL,
	"subscription_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"change_type" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"handled_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'msgraph' NOT NULL,
	"mailbox" text NOT NULL,
	"resource" text NOT NULL,
	"subscription_id" text NOT NULL,
	"client_state_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_renewed_at" timestamp,
	"removed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_subscription_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
CREATE TABLE "mailbox_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"delta_link" text,
	"delta_at" timestamp,
	"inbox_folder_id" text,
	"processed_folder_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"department_id" text NOT NULL,
	"customer_id" text,
	"contact_id" text,
	"unknown_sender" boolean DEFAULT false NOT NULL,
	"subject" text NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"assignee_id" text,
	"requester_email" text NOT NULL,
	"requester_name" text,
	"conversation_id" text,
	"service_id" text,
	"invoice_id" text,
	"first_response_at" timestamp,
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"merged_into_ticket_id" text,
	"merged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "ticket_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_canned_reply" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"department_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_department" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"mailbox" text NOT NULL,
	"channel" text DEFAULT 'msgraph' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_department_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ticket_message" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"direction" "ticket_message_direction" NOT NULL,
	"author_type" "ticket_message_author" NOT NULL,
	"author_id" text,
	"author_name" text,
	"author_email" text,
	"subject" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_text" text DEFAULT '' NOT NULL,
	"display_html" text,
	"original_html" text,
	"original_text" text,
	"internet_message_id" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"channel_message_id" text,
	"conversation_id" text,
	"is_automated" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"merged_from_ticket_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_mail" ADD CONSTRAINT "inbound_mail_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_mail" ADD CONSTRAINT "inbound_mail_ticket_message_id_ticket_message_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_department_id_ticket_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."ticket_department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_contact_id_customer_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_assignee_id_staff_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_merged_into_ticket_id_ticket_id_fk" FOREIGN KEY ("merged_into_ticket_id") REFERENCES "public"."ticket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachment" ADD CONSTRAINT "ticket_attachment_message_id_ticket_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_canned_reply" ADD CONSTRAINT "ticket_canned_reply_department_id_ticket_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."ticket_department"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_message" ADD CONSTRAINT "ticket_message_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_message" ADD CONSTRAINT "ticket_message_merged_from_ticket_id_ticket_id_fk" FOREIGN KEY ("merged_from_ticket_id") REFERENCES "public"."ticket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_reply_budget_idx" ON "auto_reply_budget" USING btree ("recipient","window");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_mail_message_idx" ON "inbound_mail" USING btree ("mailbox","internet_message_id");--> statement-breakpoint
CREATE INDEX "inbound_mail_handled_idx" ON "inbound_mail" USING btree ("handled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_notification_message_idx" ON "mail_notification" USING btree ("mailbox","resource_id");--> statement-breakpoint
CREATE INDEX "mail_notification_pending_idx" ON "mail_notification" USING btree ("handled_at");--> statement-breakpoint
CREATE INDEX "mail_subscription_mailbox_idx" ON "mail_subscription" USING btree ("mailbox");--> statement-breakpoint
CREATE INDEX "mail_subscription_expires_idx" ON "mail_subscription" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ticket_status_idx" ON "ticket" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_customer_idx" ON "ticket" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ticket_department_idx" ON "ticket" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "ticket_assignee_idx" ON "ticket" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "ticket_conversation_idx" ON "ticket" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ticket_last_message_idx" ON "ticket" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "ticket_attachment_message_idx" ON "ticket_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_attachment_key_idx" ON "ticket_attachment" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "ticket_department_mailbox_idx" ON "ticket_department" USING btree ("mailbox");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_department_mailbox_unique_idx" ON "ticket_department" USING btree ("mailbox");--> statement-breakpoint
CREATE INDEX "ticket_message_ticket_idx" ON "ticket_message" USING btree ("ticket_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_message_internet_id_idx" ON "ticket_message" USING btree ("internet_message_id");--> statement-breakpoint
CREATE INDEX "ticket_message_in_reply_to_idx" ON "ticket_message" USING btree ("in_reply_to");--> statement-breakpoint
CREATE INDEX "ticket_message_channel_id_idx" ON "ticket_message" USING btree ("channel_message_id");