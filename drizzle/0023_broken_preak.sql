CREATE TYPE "public"."ip_family" AS ENUM('ipv4', 'ipv6');--> statement-breakpoint
CREATE TYPE "public"."provisioning_action" AS ENUM('create', 'suspend', 'unsuspend', 'terminate', 'change_package', 'power', 'reinstall', 'sync');--> statement-breakpoint
CREATE TYPE "public"."provisioning_task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'aborted');--> statement-breakpoint
CREATE TABLE "ip_address" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"address" text NOT NULL,
	"reserved" boolean DEFAULT false NOT NULL,
	"service_id" text,
	"assigned_at" timestamp,
	"rdns" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_pool" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text,
	"name" text NOT NULL,
	"family" "ip_family" NOT NULL,
	"cidr" text,
	"gateway" text,
	"prefix_length" integer NOT NULL,
	"nameservers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"service_id" text NOT NULL,
	"kind" text DEFAULT 'qemu' NOT NULL,
	"external_id" text NOT NULL,
	"node" text,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_server" (
	"id" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"max_services" integer,
	"last_check_at" timestamp,
	"last_check_ok" boolean,
	"last_check_detail" text,
	"note" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_task" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"module" text NOT NULL,
	"action" "provisioning_action" NOT NULL,
	"request_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "provisioning_task_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"provider_called_at" timestamp,
	"last_error" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "server_id" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "hostname" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "provider_status_at" timestamp;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "provider_status_detail" text;--> statement-breakpoint
ALTER TABLE "ip_address" ADD CONSTRAINT "ip_address_pool_id_ip_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pool"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_address" ADD CONSTRAINT "ip_address_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_pool" ADD CONSTRAINT "ip_pool_server_id_provisioning_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."provisioning_server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_resource" ADD CONSTRAINT "provisioning_resource_server_id_provisioning_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."provisioning_server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_resource" ADD CONSTRAINT "provisioning_resource_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_task" ADD CONSTRAINT "provisioning_task_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_address_pool_address_idx" ON "ip_address" USING btree ("pool_id","address");--> statement-breakpoint
CREATE INDEX "ip_address_service_id_idx" ON "ip_address" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "ip_address_free_idx" ON "ip_address" USING btree ("pool_id","service_id");--> statement-breakpoint
CREATE INDEX "ip_pool_server_id_idx" ON "ip_pool" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "ip_pool_family_idx" ON "ip_pool" USING btree ("family");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_resource_external_idx" ON "provisioning_resource" USING btree ("server_id","kind","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_resource_service_idx" ON "provisioning_resource" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "provisioning_server_module_idx" ON "provisioning_server" USING btree ("module");--> statement-breakpoint
CREATE INDEX "provisioning_server_deleted_at_idx" ON "provisioning_server" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_task_request_idx" ON "provisioning_task" USING btree ("service_id","action","request_key");--> statement-breakpoint
CREATE INDEX "provisioning_task_service_id_idx" ON "provisioning_task" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "provisioning_task_queue_idx" ON "provisioning_task" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "service_module_idx" ON "service" USING btree ("module");--> statement-breakpoint
CREATE INDEX "service_server_id_idx" ON "service" USING btree ("server_id");