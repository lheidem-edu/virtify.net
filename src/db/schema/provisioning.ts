import {
    boolean,
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";
import { service } from "./subscriptions";

/**
 * What a provisioning module runs against, and the record of every call it
 * has made.
 *
 * Three ideas live here, and keeping them apart is the point:
 *
 *  1. **A server** is a place a module can put something — one Proxmox
 *     cluster, reached through one API token. Its secret is AES-256-GCM
 *     ciphertext (hard rule 6); its non-secret settings are validated
 *     against the `serverSchema` the module publishes.
 *  2. **An address** belongs to a pool and, while it is assigned, to exactly
 *     one service. The assignment *is* the `service_id` column, so there is
 *     no second place that could disagree about who has 192.0.2.7.
 *  3. **A task** is one request to do one thing to one service, and a
 *     **resource** is the machine that came out of it. The two are
 *     deliberately separate rows, because they answer different questions:
 *     "has this request been made" and "does this VM exist".
 *
 * The second of those is the one that matters. A job that retries must not
 * create a second VM, and the only honest key for "did this VM get made" is
 * the provider's own id — which is why `provisioning_resource` exists and
 * why the VMID is **chosen by us** before the clone is asked for
 * (`GET /cluster/nextid`, then `clone newid=`). A task id cannot answer that
 * question; a VMID we reserved and can ask the cluster about can.
 */

/** Which module a server belongs to. A text column, matching `product.module`. */
export const provisioningServer = pgTable(
    "provisioning_server",
    {
        id: ulidPk("server"),

        /**
         * `proxmox`, and whatever comes later. A server belongs to exactly
         * one module type: its `config` is validated against that module's
         * `serverSchema` and means nothing to any other.
         */
        module: text("module").notNull(),

        name: text("name").notNull(),
        /** The API host, for the operator's eyes. The URL is in `config`. */
        hostname: text("hostname"),

        enabled: boolean("enabled").notNull().default(true),

        /**
         * The module's own settings — API URL, default node, template id,
         * storage, bridge. Validated by `serverSchema` on every write, so a
         * configuration the module cannot read never reaches the column.
         */
        config: jsonb("config").notNull().default({}),

        /**
         * The API token, as one encrypted blob (rule 6). Never a column per
         * field: the blob is bound to a context string, so a row copied into
         * another installation's database does not open.
         */
        credentialsEncrypted: text("credentials_encrypted"),

        /**
         * A ceiling the panel enforces, independent of what the cluster
         * could physically take. Null means no ceiling. Counted against
         * `service.server_id`, so it is the panel's own book-keeping — the
         * module still asks the cluster about free memory when it picks a
         * node.
         */
        maxServices: integer("max_services"),

        /** What `testConnection` last said, and when. */
        lastCheckAt: timestamp("last_check_at"),
        lastCheckOk: boolean("last_check_ok"),
        lastCheckDetail: text("last_check_detail"),

        note: text("note"),

        /**
         * Rule 10: never hard-delete anything a service points at. A server
         * that is gone is `deleted_at`, and the services it provisioned keep
         * pointing at a row that still says what they are.
         */
        deletedAt: timestamp("deleted_at"),

        ...timestamps(),
    },
    (table) => [
        index("provisioning_server_module_idx").on(table.module),
        index("provisioning_server_deleted_at_idx").on(table.deletedAt),
    ],
);

export const ipFamily = pgEnum("ip_family", ["ipv4", "ipv6"]);

/**
 * A range the panel hands addresses out of.
 *
 * The pool carries what every address in it shares — the gateway, the
 * prefix, the nameservers — because that is what cloud-init needs and
 * repeating it per address is how one of them ends up wrong.
 */
export const ipPool = pgTable(
    "ip_pool",
    {
        id: ulidPk("ippool"),

        /**
         * Null for a pool that any server may draw on. Set when the range is
         * routed to one cluster, which is the usual case.
         */
        serverId: ulidFk("server_id").references(() => provisioningServer.id, {
            onDelete: "restrict",
        }),

        name: text("name").notNull(),
        family: ipFamily("family").notNull(),

        /** Documentation for a person; nothing is derived from it. */
        cidr: text("cidr"),

        /** What cloud-init is told. `prefix_length` is the mask, in bits. */
        gateway: text("gateway"),
        prefixLength: integer("prefix_length").notNull(),
        /** `["9.9.9.9", "149.112.112.112"]` — passed to `nameserver`. */
        nameservers: jsonb("nameservers").notNull().default([]),

        enabled: boolean("enabled").notNull().default(true),
        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        index("ip_pool_server_id_idx").on(table.serverId),
        index("ip_pool_family_idx").on(table.family),
    ],
);

/**
 * One address, and who has it.
 *
 * `service_id` is the assignment. There is no separate allocation table and
 * no counter: allocating is a conditional `UPDATE … WHERE service_id IS
 * NULL` over a row picked `FOR UPDATE SKIP LOCKED`, so two passes racing for
 * the last address in a pool produce one winner and one "pool erschöpft"
 * rather than two machines answering on the same address.
 *
 * `rdns` belongs to the address and not to the service, because that is
 * where it is true: it is cleared on release, since it names the host that
 * is no longer there.
 */
export const ipAddress = pgTable(
    "ip_address",
    {
        id: ulidPk("ipaddress"),
        poolId: ulidFk("pool_id")
            .notNull()
            .references(() => ipPool.id, { onDelete: "restrict" }),

        /** Canonical form, lower case for IPv6. */
        address: text("address").notNull(),

        /**
         * Held back from allocation — a gateway, a hypervisor, anything the
         * operator wants in the list but not handed out.
         */
        reserved: boolean("reserved").notNull().default(false),

        serviceId: ulidFk("service_id").references(() => service.id, {
            onDelete: "set null",
        }),
        assignedAt: timestamp("assigned_at"),

        /** The reverse record the operator set for it, while it is assigned. */
        rdns: text("rdns"),

        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        /** One row per address per pool. The same address in two pools is
         *  an operator's mistake, not something to make representable. */
        uniqueIndex("ip_address_pool_address_idx").on(
            table.poolId,
            table.address,
        ),
        index("ip_address_service_id_idx").on(table.serviceId),
        /** The allocation query: free, not reserved, in this pool. */
        index("ip_address_free_idx").on(table.poolId, table.serviceId),
    ],
);

export const provisioningAction = pgEnum("provisioning_action", [
    "create",
    "suspend",
    "unsuspend",
    "terminate",
    "change_package",
    /** start, stop, shutdown, reboot — which one is in `payload.power`. */
    "power",
    "reinstall",
    /** `getStatus`: a reading, written to `provider_status` and nowhere else. */
    "sync",
]);

export const provisioningTaskStatus = pgEnum("provisioning_task_status", [
    "pending",
    "running",
    "succeeded",
    /** Out of attempts. A person has to look; nothing retries it on its own. */
    "failed",
    /** Given up on before the provider was ever asked. Nothing was made. */
    "aborted",
]);

/**
 * One request to do one thing to one service.
 *
 * **What `(service_id, action, request_key)` speaks for.** One *request* —
 * not one attempt, not one job, not one cron pass. The caller says which
 * request it is, and every caller's key is written down in
 * `src/server/provisioning/tasks.ts`. A retry re-claims this row; a second
 * hook firing for the same cause finds it already here and adds nothing.
 *
 * **What it deliberately does not speak for.** Whether a VM exists. That is
 * `provisioning_resource`, because the answer has to come from an id the
 * provider knows. Phase 6 shipped a day-scoped claim taken by a
 * customer-scoped pass and Phase 7 shipped a per-mailbox claim behind an
 * installation-wide index; the lesson both times was to say out loud what
 * the row covers before relying on it.
 *
 * The row is also the queue. The web process holds no pg-boss instance (see
 * `src/server/jobs/worker.ts`), so `pending` here *is* the work, and the
 * worker's `provisioning/run` pass drains it. That means the operator's
 * "jetzt ausführen" and the scheduled pass run the same function against the
 * same claim and cannot double-run.
 */
export const provisioningTask = pgTable(
    "provisioning_task",
    {
        id: ulidPk("provtask"),

        serviceId: ulidFk("service_id")
            .notNull()
            .references(() => service.id, { onDelete: "cascade" }),

        /** Snapshotted from the service, so the queue reads without a join. */
        module: text("module").notNull(),
        action: provisioningAction("action").notNull(),

        /** See the header. Stated per caller in `tasks.ts`. */
        requestKey: text("request_key").notNull(),

        /** What the action needs: `{ power: "reboot" }`, a target package. */
        payload: jsonb("payload").notNull().default({}),

        status: provisioningTaskStatus("status").notNull().default("pending"),

        attempts: integer("attempts").notNull().default(0),
        /**
         * Per action, not per queue: a reboot that is retried reboots twice,
         * and a reinstall that is retried destroys a customer's data twice.
         * `src/server/provisioning/tasks.ts` sets it from the action.
         */
        maxAttempts: integer("max_attempts").notNull().default(5),

        /** Not before this. Set to now + backoff by a failed attempt. */
        runAfter: timestamp("run_after").notNull().defaultNow(),

        startedAt: timestamp("started_at"),
        finishedAt: timestamp("finished_at"),

        /**
         * The instant the first request actually went to the provider.
         *
         * This is the line between "nothing can exist" and "something might".
         * A task that aborts with this still null gives back every address
         * and VMID it reserved; one that aborts after it keeps them, because
         * a VM may be sitting on the other side of a timeout and handing its
         * address to the next customer is the worse failure.
         */
        providerCalledAt: timestamp("provider_called_at"),

        lastError: text("last_error"),
        /** Whatever the module wants on the record: a UPID, a vmid, a node. */
        result: jsonb("result").notNull().default({}),

        /** Who asked. The audit log has the full entry; this is for the list. */
        requestedBy: text("requested_by"),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("provisioning_task_request_idx").on(
            table.serviceId,
            table.action,
            table.requestKey,
        ),
        index("provisioning_task_service_id_idx").on(table.serviceId),
        /** The sweep: everything runnable, oldest first. */
        index("provisioning_task_queue_idx").on(table.status, table.runAfter),
    ],
);

/**
 * The machine itself, named by the id the provider knows it by.
 *
 * **This is what makes a create safe.** Proxmox lets the caller choose the
 * VMID, so the panel reserves one here *before* it asks for the clone, and a
 * retry re-uses it: the cluster is asked whether that VM exists, and if the
 * clone already ran the answer is yes and the retry is a success. Proxmox
 * refuses a duplicate `newid` itself with a 500 that says "already exists",
 * which the module reads as the same success. Without a reserved id the only
 * question a retry could ask is "did my request go through", which the
 * network cannot answer.
 *
 * It is released by `terminate` and by nothing else.
 */
export const provisioningResource = pgTable(
    "provisioning_resource",
    {
        id: ulidPk("provres"),

        serverId: ulidFk("server_id")
            .notNull()
            .references(() => provisioningServer.id, { onDelete: "restrict" }),
        serviceId: ulidFk("service_id")
            .notNull()
            .references(() => service.id, { onDelete: "cascade" }),

        /** `qemu` for a VM, `lxc` for a container. */
        kind: text("kind").notNull().default("qemu"),
        /** The VMID, as the provider spells it. Proxmox hands them back as
         *  strings and takes them as strings, so it is stored as one. */
        externalId: text("external_id").notNull(),

        /** The cluster node it lives on. A migration moves it; we re-read it. */
        node: text("node"),

        /**
         * When the provider confirmed it exists. Null means reserved but not
         * yet seen — which is exactly the state a retry has to resolve.
         */
        confirmedAt: timestamp("confirmed_at"),

        ...timestamps(),
    },
    (table) => [
        /** No two services on one cluster claim the same VMID. */
        uniqueIndex("provisioning_resource_external_idx").on(
            table.serverId,
            table.kind,
            table.externalId,
        ),
        /** A service is one machine. */
        uniqueIndex("provisioning_resource_service_idx").on(table.serviceId),
    ],
);

export type ProvisioningServer = typeof provisioningServer.$inferSelect;
export type IpPool = typeof ipPool.$inferSelect;
export type IpAddress = typeof ipAddress.$inferSelect;
export type ProvisioningTask = typeof provisioningTask.$inferSelect;
export type ProvisioningResource = typeof provisioningResource.$inferSelect;
export type ProvisioningActionName =
    (typeof provisioningAction.enumValues)[number];
export type ProvisioningTaskStatusName =
    (typeof provisioningTaskStatus.enumValues)[number];
export type IpFamily = (typeof ipFamily.enumValues)[number];
