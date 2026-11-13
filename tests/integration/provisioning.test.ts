import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPayment } from "@/server/payments/apply";
import { requestServiceAction } from "@/server/provisioning/actions";
import {
    enqueueCreate,
    provisionAfterSettlement,
    sweepPendingCreates,
} from "@/server/provisioning/hooks";
import { allocateAddresses, poolCounts } from "@/server/provisioning/ip-pools";
import { loadService } from "@/server/provisioning/repository";
import { runProvisioningTask } from "@/server/provisioning/runner";
import { chooseServer, serverCredentials } from "@/server/provisioning/servers";
import {
    claimTask,
    enqueueTask,
    MAX_ATTEMPTS,
    TASK_LEASE_SECONDS,
} from "@/server/provisioning/tasks";
import {
    cancelSubscription,
    transitionSubscription,
} from "@/server/subscriptions/service";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    ACTOR,
    addressesOf,
    anchored,
    makeCustomer,
    makeGroup,
    makeIpPool,
    makeProduct,
    makeProxmoxServer,
    order,
    PROXMOX_CONFIG,
    resourceOf,
    serviceOf,
    tasksOf,
    warmPool,
} from "../helpers/fixtures";
import { fakeProxmox, fakeVm } from "../helpers/proxmox";

/**
 * The provisioning lifecycle, against a real Postgres and a fake Proxmox.
 *
 * Why Postgres: every claim here is about what rows a transaction leaves
 * behind — a unique index claimed, an address that cannot be handed out
 * twice, a status that only moves from the set it is allowed to move from. A
 * mock cannot be wrong about those in the way a database can.
 *
 * Why a fake cluster: there is none for this installation and no credentials
 * were gone looking for. The fake answers in the real API's shapes, including
 * the awkward ones — see its header.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the provisioning proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const SETTINGS = anchored(1);
const NOW = new Date("2026-03-01T10:00:00.000Z");

/** Customer numbers and slugs have to be unique; one counter does both. */
let seq = 0;

function next(): number {
    seq += 1;

    return 8000 + seq;
}

describe.skipIf(!available)("provisioning", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());
        await warmPool(db, 8);
    });

    afterAll(async () => {
        await drop?.();
    });

    /** A customer with one ordered, still-pending VPS on a Proxmox product. */
    async function scenario(
        options: {
            ipv4Count?: number;
            ipv6Count?: number;
            poolSize?: number;
            provisioningMode?: "manual" | "auto_on_payment";
            quantity?: number;
            maxServices?: number | null;
            serverEnabled?: boolean;
            withToken?: boolean;
            config?: Record<string, unknown>;
        } = {},
    ) {
        const n = next();

        /**
         * Each scenario gets the cluster to itself. `chooseServer` picks by
         * headroom and every fixture server is unlimited, so without this
         * every service in the suite would land on the first one ever made —
         * and then draw addresses from *its* pool, which is a different
         * scenario's.
         */
        await db
            .update(schema.provisioningServer)
            .set({ enabled: false })
            .where(eq(schema.provisioningServer.module, "proxmox"));

        const customerId = await makeCustomer(db, n);
        const groupId = await makeGroup(db, `vps-${n}`);
        const serverId = await makeProxmoxServer(db, {
            name: `pve-${n}`,
            maxServices: options.maxServices ?? null,
            enabled: options.serverEnabled ?? true,
            withToken: options.withToken ?? true,
        });

        if ((options.poolSize ?? 4) > 0) {
            await makeIpPool(db, {
                serverId,
                count: options.poolSize ?? 4,
                // A window of its own per scenario, so two pools in one
                // database never ask for the same address.
                first: 10 + seq * 8,
            });
        }

        if ((options.ipv6Count ?? 0) > 0) {
            await makeIpPool(db, {
                serverId,
                family: "ipv6",
                count: 4,
                first: 10 + seq * 8,
            });
        }

        const productId = await makeProduct(db, {
            groupId,
            slug: `vps-${n}`,
            name: "VPS M",
            cycle: "monthly",
            priceCents: 1900,
            module: "proxmox",
            provisioningMode: options.provisioningMode ?? "auto_on_payment",
            moduleConfig: {
                ...PROXMOX_CONFIG,
                ipv4Count: options.ipv4Count ?? 1,
                ipv6Count: options.ipv6Count ?? 0,
                ...(options.config ?? {}),
            },
        });

        const placed = await order(db, {
            customerId,
            items: [
                {
                    productId,
                    cycle: "monthly",
                    quantity: options.quantity ?? 1,
                },
            ],
            now: NOW,
            settings: SETTINGS,
        });

        const services = await db
            .select()
            .from(schema.service)
            .where(eq(schema.service.customerId, customerId));

        return {
            customerId,
            productId,
            serverId,
            order: placed,
            services,
            service: services[0],
        };
    }

    async function runCreate(
        serviceId: string,
        fake: ReturnType<typeof fakeProxmox>,
    ) {
        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId,
                action: "create",
                requestKey: "create",
            }),
        );

        return runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
            sleepImpl: fake.sleep,
        });
    }

    // --- the happy path -----------------------------------------------

    it("creates a VM, writes the credentials and activates the service", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(true);

        const after = await serviceOf(db, service.id);

        expect(after.status).toBe("active");
        expect(after.activatedAt).not.toBeNull();
        expect(after.hostname).toMatch(/^vps-m-101$/);
        // Rule 6: the password is ciphertext, never plain text in a column.
        expect(after.credentialsEncrypted).toBeTruthy();
        expect(after.credentialsEncrypted).not.toContain("root");

        const resource = await resourceOf(db, service.id);

        expect(resource?.externalId).toBe("101");
        expect(resource?.confirmedAt).not.toBeNull();
        expect(fake.vms.get("101")?.status).toBe("running");
    });

    it("gives cloud-init the address, the gateway and the resolver", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const config = fake.paramsFor("/qemu/101/config");
        const [address] = await addressesOf(db, service.id);

        expect(config?.ipconfig0).toBe(`ip=${address.address}/24,gw=192.0.2.1`);
        expect(config?.nameserver).toBe("9.9.9.9");
        expect(config?.ciuser).toBe("root");
        expect(config?.cores).toBe("2");
        expect(config?.memory).toBe("2048");
    });

    it("grows the disk from the template's size to the ordered size", async () => {
        const { service } = await scenario();
        // The template brings 10 GiB; the product orders 40 GB.
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        // Proxmox takes a delta, not a target.
        expect(fake.paramsFor("/resize")?.size).toMatch(/^\+\d+G$/);
        expect(fake.vm("101").maxdisk).toBeGreaterThanOrEqual(40 * 1000 ** 3);
    });

    /**
     * Proxmox cannot shrink a disk. A panel that pretended otherwise would
     * leave a customer on the template's size while reporting success, so
     * this is a warning on the task and the create still goes through.
     */
    it("warns rather than fails when the template is bigger than the package", async () => {
        const { service } = await scenario({ config: { diskGiB: 5 } });
        const fake = fakeProxmox();

        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(outcome.ran && outcome.warnings.join(" ")).toMatch(
            /nicht verkleinern/,
        );
        expect(fake.callsTo("/resize")).toEqual([]);
    });

    it("takes one address of each family a product asks for", async () => {
        const { service } = await scenario({ ipv4Count: 2, ipv6Count: 1 });
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const addresses = await addressesOf(db, service.id);

        expect(addresses).toHaveLength(3);
        expect(fake.paramsFor("/qemu/101/config")?.ipconfig0).toMatch(
            /^ip=.*,gw=.*,ip6=.*,gw6=/,
        );
    });

    // --- idempotency ----------------------------------------------------

    /**
     * The headline claim of this phase. The VMID is ours before the clone is
     * asked for, so a retry can ask "does 101 exist" — and when it does, the
     * retry is a success rather than a second machine.
     */
    it("does not create a second VM when the create is run again", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const vmsAfterFirst = [...fake.vms.keys()];

        // The same request, asked again. `enqueueTask` finds the succeeded
        // row and `claimTask` refuses it.
        const second = await runCreate(service.id, fake);

        expect(second.ran).toBe(false);
        expect([...fake.vms.keys()]).toEqual(vmsAfterFirst);
    });

    it("resumes with the same VMID after a timeout, and succeeds", async () => {
        const { service } = await scenario();

        /**
         * The clone's answer never arrives — but the clone itself ran. This
         * is the case that costs a customer two machines in a panel that
         * keys idempotency on anything but the provider's own id.
         */
        const broken = fakeProxmox({ unreachable: ["/clone"] });
        const first = await runCreate(service.id, broken);

        expect(first.ran && first.ok).toBe(false);

        const resource = await resourceOf(db, service.id);

        expect(resource?.externalId).toBe("101");
        expect(resource?.confirmedAt).toBeNull();

        // The cluster did make it, we just never heard. A fresh fake with
        // VM 101 already present is exactly that state.
        const recovered = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101", node: "pve1" })],
        });

        const [task] = await tasksOf(db, service.id);

        /**
         * Past the backoff the failed attempt set. A task that failed waits
         * — one minute for the first rung — and claiming it before then is
         * refused, which is the behaviour and not an obstacle.
         */
        expect(task.runAfter.getTime()).toBeGreaterThan(Date.now());

        const second = await runProvisioningTask(db, task.id, {
            actor: ACTOR,
            at: new Date(Date.now() + 120_000),
            fetchImpl: recovered.fetchImpl,
            sleepImpl: recovered.sleep,
        });

        expect(second.ran && second.ok).toBe(true);
        expect(second.ran && second.alreadyDone).toBe(true);
        expect(recovered.callsTo("/clone")).toEqual([]);
        expect((await serviceOf(db, service.id)).status).toBe("active");
    });

    /**
     * And when Proxmox itself is the one who notices: the clone goes out a
     * second time and PVE refuses it with `500 VM 101 already exists`. That
     * is the "already done is a success" of trap 4.
     */
    it("reads PVE's own 'already exists' as a success", async () => {
        const { service } = await scenario();

        /**
         * The VM is there, but the first status read says it is not — a
         * config that has just been written is briefly not visible from
         * every node of a cluster. So the module clones again, and PVE
         * refuses with `500 VM 101 already exists`. **That refusal is a
         * success**: the machine the customer is paying for exists, and
         * treating it as a failure would leave the service `pending` for
         * ever while the task burned its attempts.
         */
        const fake = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101", node: "pve1" })],
            missingOnce: ["101"],
            nextId: 101,
        });

        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(fake.callsTo("/clone")).toHaveLength(1);
        // Still two: the template and the one machine.
        expect(fake.vms.size).toBe(2);
        expect((await serviceOf(db, service.id)).status).toBe("active");
        expect((await tasksOf(db, service.id))[0].status).toBe("succeeded");
    });

    it("keeps one task row however many times the same request is made", async () => {
        const { service } = await scenario();

        for (let index = 0; index < 5; index += 1) {
            await db.transaction((tx) => enqueueCreate(tx, service.id));
        }

        const tasks = await tasksOf(db, service.id);

        expect(tasks).toHaveLength(1);
        expect(tasks[0].requestKey).toBe("create");
    });

    it("reports `created: false` for the second caller of one request", async () => {
        const { service } = await scenario();

        const first = await db.transaction((tx) =>
            enqueueCreate(tx, service.id),
        );
        const second = await db.transaction((tx) =>
            enqueueCreate(tx, service.id),
        );

        expect(first).toBe(true);
        expect(second).toBe(false);
    });

    /**
     * The loop-breaker for the sweep. Once the create has succeeded, asking
     * again finds a `succeeded` row and does not re-open it — which is what
     * makes a pass that runs every minute free.
     */
    it("never re-opens a request that has succeeded", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        await db.transaction((tx) => enqueueCreate(tx, service.id));

        const [task] = await tasksOf(db, service.id);

        expect(task.status).toBe("succeeded");
    });

    // --- both directions -------------------------------------------------

    it("gives the address and the VMID back when the service is torn down", async () => {
        const { service, serverId } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const pools = await db
            .select()
            .from(schema.ipPool)
            .where(eq(schema.ipPool.serverId, serverId));
        const before = await poolCounts(db, pools[0].id);

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:test",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
            sleepImpl: fake.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(await addressesOf(db, service.id)).toEqual([]);
        expect(await resourceOf(db, service.id)).toBeNull();
        expect((await poolCounts(db, pools[0].id)).free).toBe(before.free + 1);
        expect(fake.vms.has("101")).toBe(false);
        expect((await serviceOf(db, service.id)).status).toBe("terminated");
    });

    it("clears the rDNS with the address, so the next customer does not inherit it", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const [address] = await addressesOf(db, service.id);

        await db
            .update(schema.ipAddress)
            .set({ rdns: "vps-17.virtify.net" })
            .where(eq(schema.ipAddress.id, address.id));

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:rdns",
            }),
        );

        await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        const [row] = await db
            .select()
            .from(schema.ipAddress)
            .where(eq(schema.ipAddress.id, address.id));

        expect(row.serviceId).toBeNull();
        expect(row.rdns).toBeNull();
        expect(row.assignedAt).toBeNull();
    });

    /**
     * "A VM that is not there does not need destroying." Without this, a
     * retried terminate fails for ever, the addresses are never released,
     * and a pool bleeds one address per cancelled customer.
     */
    it("treats a VM that is already gone as a successful teardown", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        // Somebody deleted it in the Proxmox UI.
        fake.vms.delete("101");

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:gone",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(outcome.ran && outcome.alreadyDone).toBe(true);
        expect(await addressesOf(db, service.id)).toEqual([]);
    });

    /**
     * The *other* half of "already gone is a success", and the one a test of
     * the status read does not reach: the VM is there when we look and gone
     * by the time we destroy it. Somebody deleted it in the Proxmox UI
     * between the two calls — rare, and exactly the kind of race that leaves
     * a pool bleeding one address per cancelled customer if the failure
     * sticks.
     */
    it("treats a VM deleted between the look and the destroy as done", async () => {
        const { service } = await scenario();
        const good = fakeProxmox();

        await runCreate(service.id, good);

        const racing = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101", status: "stopped" })],
            failWith: {
                "qemu/101?": `Configuration file 'nodes/pve1/qemu-server/101.conf' does not exist`,
            },
        });

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:race",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: racing.fetchImpl,
            sleepImpl: racing.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(outcome.ran && outcome.alreadyDone).toBe(true);
        expect(await addressesOf(db, service.id)).toEqual([]);
        expect(await resourceOf(db, service.id)).toBeNull();
    });

    /**
     * The abort path, and the line it turns on. Nothing reached the
     * provider, so nothing can exist, so everything this attempt took goes
     * back.
     */
    it("releases exactly what it took when it aborts before the provider", async () => {
        const { service, serverId } = await scenario({ poolSize: 0 });

        // No pool at all: the allocation fails before any provider call.
        const fake = fakeProxmox();
        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(false);

        const [task] = await tasksOf(db, service.id);

        /**
         * An empty pool is the request **waiting**, not failing: the
         * operator adds a range and it goes through. So the row goes back
         * on the queue with its attempt returned and a backoff on it —
         * spending one of five on the discovery that a pool is still empty
         * used to kill a create permanently about a quarter of an hour
         * after the order, with nothing wrong except that the panel was
         * new. What it must still do is give back everything it took.
         */
        expect(outcome.ran && outcome.terminal).toBe(false);
        expect(task.status).toBe("pending");
        expect(task.attempts).toBe(0);
        expect(task.runAfter.getTime()).toBeGreaterThan(Date.now());
        expect(task.providerCalledAt).toBeNull();
        expect(await resourceOf(db, service.id)).toBeNull();
        expect(await addressesOf(db, service.id)).toEqual([]);
        // Not one request went out.
        expect(fake.calls).toEqual([]);
        expect(serverId).toBeTruthy();
    });

    /**
     * The other half of the same line: a precondition that will **not**
     * resolve itself is a failure, and it spends an attempt like any other.
     */
    /**
     * The two mechanisms that wedged a service between them. Each was right
     * on its own: a request keeps its attempt count when it is asked for
     * again, and the create sweep re-opens a failed row every minute. A
     * create that had spent its ladder was therefore relabelled `pending`,
     * where nothing could claim it — `attempts < max_attempts` — and
     * „Erneut versuchen“, which matches `failed` and `aborted`, could no
     * longer see it either. The row read as queued, nothing ran it, and the
     * only way out was SQL.
     */
    it("leaves a spent request visibly spent, so the retry button still finds it", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox({ unreachable: ["/clone"] });

        for (let attempt = 0; attempt < MAX_ATTEMPTS.create; attempt += 1) {
            await db
                .update(schema.provisioningTask)
                .set({ runAfter: new Date(Date.now() - 1000) })
                .where(eq(schema.provisioningTask.serviceId, service.id));

            await runCreate(service.id, fake);
        }

        const [spent] = await tasksOf(db, service.id);

        expect(spent.attempts).toBe(MAX_ATTEMPTS.create);
        expect(spent.status).toBe("failed");

        // The sweep asks again, a minute later and every minute after that.
        await db.transaction((tx) => enqueueCreate(tx, service.id, "worker"));

        const [asked] = await tasksOf(db, service.id);

        expect(asked.status).toBe("failed");
        expect(asked.attempts).toBe(MAX_ATTEMPTS.create);

        /**
         * And the operator's recovery works: the button matches `failed`,
         * gives the request its attempts back, and the create goes through
         * once the cluster answers.
         */
        await db
            .update(schema.provisioningTask)
            .set({ attempts: 0, status: "pending", runAfter: new Date() })
            .where(eq(schema.provisioningTask.id, asked.id));

        const outcome = await runProvisioningTask(db, asked.id, {
            actor: ACTOR,
            fetchImpl: fakeProxmox().fetchImpl,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect((await serviceOf(db, service.id)).status).toBe("active");
    });

    /**
     * A claim is a committed `running` row and the call that holds it runs
     * for minutes outside any transaction. A worker killed mid-clone — a
     * redeploy, an OOM — used to leave that row behind for ever: no sweep,
     * no button and no API call could touch the service again.
     */
    it("takes back a claim whose worker is gone, and not one that is still held", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "create",
                requestKey: "create",
            }),
        );

        // Somebody claims it and dies.
        const claimed = await claimTask(db, taskId, new Date());

        expect(claimed?.status).toBe("running");
        expect(await claimTask(db, taskId, new Date())).toBeNull();

        const stale = new Date(Date.now() + (TASK_LEASE_SECONDS + 60) * 1000);

        expect(await claimTask(db, taskId, stale)).not.toBeNull();

        await db
            .update(schema.provisioningTask)
            .set({ status: "pending", attempts: 0, runAfter: new Date() })
            .where(eq(schema.provisioningTask.id, taskId));

        expect(
            await runProvisioningTask(db, taskId, {
                actor: ACTOR,
                fetchImpl: fake.fetchImpl,
                sleepImpl: fake.sleep,
            }).then((outcome) => outcome.ran && outcome.ok),
        ).toBe(true);
    });

    /**
     * One service, one call at a time. Two tasks on one machine is how a
     * terminate that overtakes an in-flight create releases the addresses
     * the create is at that moment writing into cloud-init.
     */
    it("will not run a second task on a service that already has one running", async () => {
        const { service } = await scenario();

        const first = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "create",
                requestKey: "create",
            }),
        );
        const second = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:overtake",
            }),
        );

        expect(await claimTask(db, first.taskId, new Date())).not.toBeNull();
        expect(await claimTask(db, second.taskId, new Date())).toBeNull();

        // Once the first is finished the second may go.
        await db
            .update(schema.provisioningTask)
            .set({ status: "succeeded" })
            .where(eq(schema.provisioningTask.id, first.taskId));

        expect(await claimTask(db, second.taskId, new Date())).not.toBeNull();
    });

    /**
     * `create` is queued under one key for ever, so a cancellation that
     * overtakes a failed create does not cancel it — the row is still there
     * and still runnable. Building the machine then leaves one on the
     * cluster that nothing in the panel points at.
     */
    it("does not build a machine for a service that has been terminated", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox({ unreachable: ["/clone"] });

        await runCreate(service.id, fake);

        await db
            .update(schema.service)
            .set({ status: "terminated", terminatedAt: new Date() })
            .where(eq(schema.service.id, service.id));

        const [task] = await tasksOf(db, service.id);

        await db
            .update(schema.provisioningTask)
            .set({ runAfter: new Date(Date.now() - 1000) })
            .where(eq(schema.provisioningTask.id, task.id));

        const healthy = fakeProxmox();
        const outcome = await runProvisioningTask(db, task.id, {
            actor: ACTOR,
            fetchImpl: healthy.fetchImpl,
            sleepImpl: healthy.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(false);
        expect(healthy.callsTo("/clone")).toEqual([]);
        expect((await serviceOf(db, service.id)).status).toBe("terminated");
    });

    /**
     * PVE writes the target's configuration at the *start* of a clone and
     * holds `lock: "clone"` until the copy is done. A create retried while
     * the first clone was still running found the VM, concluded "already
     * there", and configured it — which PVE refuses, permanently, so any
     * clone slower than the task deadline ended with a VMID held, addresses
     * held, cloud-init never applied and a paid invoice.
     */
    it("waits for a clone that is still running instead of configuring it", async () => {
        const { service } = await scenario();
        // The first attempt reserves the VMID and asks for the clone; the
        // answer never arrives, which is exactly the case this is about.
        const lost = fakeProxmox({ unreachable: ["/clone"] });

        await runCreate(service.id, lost);

        const vmid = (await resourceOf(db, service.id))?.externalId as string;
        const building = fakeProxmox({
            vms: [
                fakeVm({
                    vmid,
                    node: "pve1",
                    lock: "clone",
                    status: "stopped",
                }),
                fakeVm({ vmid: "9000", node: "pve1" }),
            ],
            nextId: Number(vmid) + 1,
        });

        const [task] = await tasksOf(db, service.id);

        await db
            .update(schema.provisioningTask)
            .set({
                status: "pending",
                attempts: 0,
                runAfter: new Date(Date.now() - 1000),
            })
            .where(eq(schema.provisioningTask.id, task.id));

        const outcome = await runProvisioningTask(db, task.id, {
            actor: ACTOR,
            fetchImpl: building.fetchImpl,
            sleepImpl: building.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(false);
        // Not configured, and not given up on either.
        expect(building.callsTo("/config")).toEqual([]);
        expect(outcome.ran && outcome.terminal).toBe(false);
        expect(await resourceOf(db, service.id)).not.toBeNull();
    });

    /**
     * "Not on the node we remember" is not "gone". An operator who migrates
     * a VM in the Proxmox UI moves it, and the old node then answers `does
     * not exist` — which `terminate` read as its documented success, booked
     * the service as torn down and put the customer's addresses back in the
     * pool while the machine kept running and answering on one of them.
     */
    it("finds a migrated VM before it believes the machine is gone", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const resource = await resourceOf(db, service.id);
        const vmid = resource?.externalId as string;

        expect(resource?.node).toBe("pve1");

        // Somebody migrated it to the other node.
        const migrated = fakeProxmox({
            nodes: [{ node: "pve1" }, { node: "pve2" }],
            vms: [fakeVm({ vmid, node: "pve2", status: "running" })],
        });

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:migrated",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: migrated.fetchImpl,
            sleepImpl: migrated.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        // It was actually destroyed, on the node it is really on.
        expect(
            migrated.calls.some(
                (call) =>
                    call.method === "DELETE" && call.path.includes("/pve2/"),
            ),
        ).toBe(true);
        expect(migrated.vms.has(vmid)).toBe(false);
        expect(await addressesOf(db, service.id)).toEqual([]);
    });

    /**
     * The other half: a machine that really is gone everywhere is still a
     * successful teardown, or a cancelled customer's addresses would never
     * come back.
     */
    it("still releases when the VM is gone from the whole cluster", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const vmid = (await resourceOf(db, service.id))?.externalId as string;
        const empty = fakeProxmox({ vms: [] });

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:really-gone",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: empty.fetchImpl,
            sleepImpl: empty.sleep,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(outcome.ran && outcome.alreadyDone).toBe(true);
        expect(empty.vms.has(vmid)).toBe(false);
        expect(await addressesOf(db, service.id)).toEqual([]);
        expect(await resourceOf(db, service.id)).toBeNull();
    });

    /**
     * A terminate is the end of a service, and `provider_status` is never
     * read again for one — `enqueueStatusSync` only asks about `active` and
     * `suspended`. Left at the last hourly reading, every normally
     * cancelled service showed „auf dem Server existiert aber noch eine
     * Maschine“ for ever, which is the one warning that is supposed to mean
     * somebody should go and look.
     */
    it("records that the machine is gone when it tears one down", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        await db
            .update(schema.service)
            .set({ providerStatus: "running", providerStatusAt: new Date() })
            .where(eq(schema.service.id, service.id));

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "terminate",
                requestKey: "manual:status",
            }),
        );

        await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
            sleepImpl: fake.sleep,
        });

        const after = await serviceOf(db, service.id);

        expect(after.status).toBe("terminated");
        expect(after.providerStatus).toBe("missing");
    });

    it("spends an attempt when an abort is the request's own fault", async () => {
        const { service, serverId } = await scenario({ poolSize: 2 });
        const fake = fakeProxmox();
        const { encrypt } = await import("@/lib/crypto");

        /**
         * A token that is stored but is not a token. Nothing can make that
         * work by waiting, so unlike an empty pool it is a real failure: it
         * ends `aborted` and it costs one of the five.
         */
        await db
            .update(schema.provisioningServer)
            .set({
                credentialsEncrypted: encrypt(
                    JSON.stringify({ tokenId: "nonsense", tokenSecret: "x" }),
                    `provisioning_server.${serverId}.token`,
                ),
            })
            .where(eq(schema.provisioningServer.id, serverId));

        const outcome = await runCreate(service.id, fake);
        const [task] = await tasksOf(db, service.id);

        expect(outcome.ran && outcome.ok).toBe(false);
        expect(outcome.ran && outcome.terminal).toBe(true);
        expect(task.status).toBe("aborted");
        expect(task.attempts).toBe(1);
        expect(fake.calls).toEqual([]);
        expect(await addressesOf(db, service.id)).toEqual([]);
    });

    it("hands back only this attempt's addresses, not ones already held", async () => {
        const { service } = await scenario({ ipv4Count: 1, poolSize: 1 });
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        expect(await addressesOf(db, service.id)).toHaveLength(1);

        /**
         * Now the product wants two and the pool has none left. The second
         * allocation fails, the attempt aborts — and the address the service
         * already has must stay exactly where it is.
         */
        await db
            .update(schema.product)
            .set({
                moduleConfig: { ...PROXMOX_CONFIG, ipv4Count: 2 },
            })
            .where(eq(schema.product.id, service.productId));

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "create",
                requestKey: "second-attempt",
            }),
        );

        await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        expect(await addressesOf(db, service.id)).toHaveLength(1);
    });

    /**
     * Past the line, nothing is released — a VM may be sitting on the other
     * side of the timeout, and handing its address to the next customer is a
     * worse failure than leaking one.
     */
    it("keeps the address and the VMID when the create fails after the clone", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox({ failWith: { "/resize": "disk full" } });

        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(false);

        const [task] = await tasksOf(db, service.id);

        expect(task.status).toBe("failed");
        expect(task.providerCalledAt).not.toBeNull();
        expect(await addressesOf(db, service.id)).toHaveLength(1);
        expect((await resourceOf(db, service.id))?.externalId).toBe("101");
    });

    it("does not allocate a second address for a service that already has one", async () => {
        const { service, serverId } = await scenario({ poolSize: 4 });

        const first = await db.transaction((tx) =>
            allocateAddresses(tx, {
                family: "ipv4",
                count: 1,
                serviceId: service.id,
                serverId,
            }),
        );
        const second = await db.transaction((tx) =>
            allocateAddresses(tx, {
                family: "ipv4",
                count: 1,
                serviceId: service.id,
                serverId,
            }),
        );

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect(second[0].id).toBe(first[0].id);
        expect(await addressesOf(db, service.id)).toHaveLength(1);
    });

    it("hands the last free address to exactly one of two racing passes", async () => {
        const a = await scenario({ poolSize: 1 });
        const poolRows = await db
            .select()
            .from(schema.ipPool)
            .where(eq(schema.ipPool.serverId, a.serverId));
        const b = await scenario({ poolSize: 0 });

        // Point the second service at the same (single-address) pool.
        const results = await Promise.allSettled([
            db.transaction((tx) =>
                allocateAddresses(tx, {
                    family: "ipv4",
                    count: 1,
                    poolId: poolRows[0].id,
                    serviceId: a.service.id,
                    serverId: a.serverId,
                }),
            ),
            db.transaction((tx) =>
                allocateAddresses(tx, {
                    family: "ipv4",
                    count: 1,
                    poolId: poolRows[0].id,
                    serviceId: b.service.id,
                    serverId: a.serverId,
                }),
            ),
        ]);

        const winners = results.filter(
            (result) => result.status === "fulfilled",
        );

        expect(winners).toHaveLength(1);
        expect((await poolCounts(db, poolRows[0].id)).free).toBe(0);
    });

    // --- suspend, unsuspend ----------------------------------------------

    it("stops the machine and takes it off the host's boot list", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        expect(fake.vms.get("101")?.status).toBe("running");

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "suspend",
                requestKey: "manual:suspend",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(fake.vms.get("101")?.status).toBe("stopped");
        /**
         * The part that actually matters: without `onboot=0` the next host
         * reboot brings a suspended customer's machine straight back.
         */
        expect(fake.vms.get("101")?.config.onboot).toBe("0");
    });

    /**
     * Setting `lock` is root@pam only, and the setup guide asks for a
     * restricted token. The stop is the suspension; the lock is a second
     * belt, and a belt that cannot be fastened is a note, not a failure.
     */
    it("reports a refused lock as a warning, not a failure", async () => {
        const { service, serverId } = await scenario();
        const fake = fakeProxmox({ restrictedToken: true });

        await runCreate(service.id, fake);

        await db
            .update(schema.provisioningServer)
            .set({
                config: {
                    apiUrl: "https://pve.example.net:8006",
                    templateVmid: "9000",
                    templateNode: "pve1",
                    bridge: "vmbr0",
                    diskBus: "scsi0",
                    lockOnSuspend: true,
                },
            })
            .where(eq(schema.provisioningServer.id, serverId));

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "suspend",
                requestKey: "manual:locked",
            }),
        );

        const outcome = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        expect(outcome.ran && outcome.ok).toBe(true);
        expect(outcome.ran && outcome.warnings.join(" ")).toMatch(/root@pam/);
        expect(fake.vms.get("101")?.status).toBe("stopped");
    });

    it("restores the boot flag and starts the machine on unsuspend", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        for (const [action, key] of [
            ["suspend", "s1"],
            ["unsuspend", "u1"],
        ] as const) {
            const { taskId } = await db.transaction((tx) =>
                enqueueTask(tx, {
                    serviceId: service.id,
                    action,
                    requestKey: key,
                }),
            );

            await runProvisioningTask(db, taskId, {
                actor: ACTOR,
                fetchImpl: fake.fetchImpl,
            });
        }

        expect(fake.vms.get("101")?.status).toBe("running");
        expect(fake.vms.get("101")?.config.onboot).toBe("1");
    });

    // --- who wins when the provider disagrees -----------------------------

    /**
     * Trap 1, stated as a test. A reading goes into `provider_status`, which
     * nothing acts on; `service.status` is untouched. If it were not, a VM an
     * operator stopped by hand under an active Abo would be woken by the
     * mirror in `wakeSettledIn` and stopped again by the next sync — for ever.
     */
    it("never writes a provider reading into service.status", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        expect((await serviceOf(db, service.id)).status).toBe("active");

        // Somebody stops it in the Proxmox UI.
        fake.vm("101").status = "stopped";

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "sync",
                requestKey: "sync:2026-03-01T10",
            }),
        );

        await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        const after = await serviceOf(db, service.id);

        expect(after.status).toBe("active");
        expect(after.providerStatus).toBe("stopped");

        const loaded = await loadService(db, service.id, service.customerId);

        expect(loaded?.mismatch).toMatch(/läuft aber nicht/);
    });

    it("records a VM that has vanished as missing, and still not as a status", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        fake.vms.delete("101");

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "sync",
                requestKey: "sync:missing",
            }),
        );

        await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: fake.fetchImpl,
        });

        const after = await serviceOf(db, service.id);

        expect(after.providerStatus).toBe("missing");
        expect(after.status).toBe("active");
    });

    // --- the money guard ---------------------------------------------------

    /**
     * The one guard in this phase that is about money. Without it the whole
     * dunning ladder is a button away from being undone.
     */
    it("refuses a power action on a suspended service", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);
        await db
            .update(schema.service)
            .set({ status: "suspended" })
            .where(eq(schema.service.id, service.id));

        fake.vm("101").status = "stopped";

        const result = await requestServiceAction(db, {
            serviceId: service.id,
            customer: service.customerId,
            action: "start",
            asCustomer: true,
            actor: { type: "customer", id: service.customerId },
            fetchImpl: fake.fetchImpl,
        });

        expect(result.outcome?.ran && result.outcome.ok).toBe(false);
        expect(fake.vms.get("101")?.status).toBe("stopped");
    });

    it("refuses a staff-only action asked for as the customer", async () => {
        const { service } = await scenario();

        await expect(
            requestServiceAction(db, {
                serviceId: service.id,
                customer: service.customerId,
                action: "unsuspend",
                asCustomer: true,
                actor: { type: "customer", id: service.customerId },
            }),
        ).rejects.toThrow(/nicht vorgesehen/);
    });

    /**
     * 404, never 403 (rule 5). A customer naming somebody else's service id
     * gets `null`, which every caller turns into "there is nothing here".
     */
    it("hands back nothing at all for somebody else's service", async () => {
        const mine = await scenario();
        const theirs = await scenario();

        const result = await requestServiceAction(db, {
            serviceId: theirs.service.id,
            customer: mine.customerId,
            action: "start",
            asCustomer: true,
            actor: { type: "customer", id: mine.customerId },
        });

        expect(result.outcome).toBeNull();
        expect(
            await loadService(db, theirs.service.id, mine.customerId),
        ).toBeNull();
    });

    // --- attempt ladders ----------------------------------------------------

    /**
     * A reboot is not idempotent: a retry is a second reboot of a machine
     * whose owner asked for one. So `power` gets exactly one attempt.
     */
    it("gives a power action one attempt and no more", async () => {
        const { service } = await scenario();
        const good = fakeProxmox();

        await runCreate(service.id, good);

        const broken = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101", status: "running" })],
            unreachable: ["/status/reboot"],
        });

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "power",
                requestKey: "manual:reboot-1",
                payload: { power: "reboot" },
            }),
        );

        const first = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: broken.fetchImpl,
            sleepImpl: broken.sleep,
        });

        expect(first.ran && first.ok).toBe(false);
        expect(first.ran && first.terminal).toBe(true);

        // And it cannot be claimed again: one rung is one rung.
        const again = await runProvisioningTask(db, taskId, {
            actor: ACTOR,
            fetchImpl: broken.fetchImpl,
        });

        expect(again.ran).toBe(false);
    });

    it("gives a create five attempts, because it is safe to repeat", async () => {
        const { service } = await scenario();

        /**
         * Through `enqueueTask`, which is what decides the ladder. The
         * first version of this inserted a row with `maxAttempts: 5` by
         * hand and read the 5 back — a tautology that would have passed
         * with the whole `MAX_ATTEMPTS` table set to one.
         */
        const created = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "create",
                requestKey: "ladder",
            }),
        );

        const [row] = await db
            .select()
            .from(schema.provisioningTask)
            .where(eq(schema.provisioningTask.id, created.taskId));

        expect(row.maxAttempts).toBe(5);
        expect(row.maxAttempts).toBe(MAX_ATTEMPTS.create);

        const { taskId } = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "reinstall",
                requestKey: "manual:reinstall",
            }),
        );

        const [reinstall] = await db
            .select()
            .from(schema.provisioningTask)
            .where(eq(schema.provisioningTask.id, taskId));

        // One. It destroys data; nothing automatic may do that twice.
        expect(reinstall.maxAttempts).toBe(1);
    });

    // --- the hooks ------------------------------------------------------------

    it("suspends the machine when dunning suspends the service", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const [item] = await db
            .select()
            .from(schema.subscriptionItem)
            .where(
                eq(
                    schema.subscriptionItem.id,
                    service.subscriptionItemId as string,
                ),
            );

        await transitionSubscription(db, {
            subscriptionId: item.subscriptionId,
            to: "paused",
            summary: "Test",
            actor: ACTOR,
            at: NOW,
        });

        const tasks = await tasksOf(db, service.id);
        const suspend = tasks.find((task) => task.action === "suspend");

        expect(suspend).toBeDefined();
        expect(suspend?.status).toBe("pending");
        expect((await serviceOf(db, service.id)).status).toBe("suspended");
    });

    /**
     * The loop-breaker: `applyServiceFollow` moves only rows whose status is
     * in the set it moves *from*, so a second pass moves nothing and asks for
     * nothing. A hook keyed on the value rather than the change would
     * re-suspend for as long as anything kept asking.
     */
    it("asks for one suspension however often the status is written", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const [item] = await db
            .select()
            .from(schema.subscriptionItem)
            .where(
                eq(
                    schema.subscriptionItem.id,
                    service.subscriptionItemId as string,
                ),
            );

        await transitionSubscription(db, {
            subscriptionId: item.subscriptionId,
            to: "paused",
            summary: "Erst",
            actor: ACTOR,
            at: NOW,
        });

        // Paused → paused is refused by the state machine, so go round and
        // come back: active (held nowhere) then paused again is a *second*
        // occurrence and deserves a second request.
        await transitionSubscription(db, {
            subscriptionId: item.subscriptionId,
            to: "active",
            summary: "Zurück",
            actor: ACTOR,
            at: new Date(NOW.getTime() + 60_000),
        });

        const tasks = await tasksOf(db, service.id);

        expect(tasks.filter((task) => task.action === "suspend")).toHaveLength(
            1,
        );
        expect(
            tasks.filter((task) => task.action === "unsuspend"),
        ).toHaveLength(1);
    });

    it("tears the machine down when the Abo ends", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const [item] = await db
            .select()
            .from(schema.subscriptionItem)
            .where(
                eq(
                    schema.subscriptionItem.id,
                    service.subscriptionItemId as string,
                ),
            );

        await cancelSubscription(db, {
            subscriptionId: item.subscriptionId,
            when: "now",
            actor: ACTOR,
            at: NOW,
            settings: SETTINGS,
        });

        const terminate = (await tasksOf(db, service.id)).find(
            (task) => task.action === "terminate",
        );

        expect(terminate).toBeDefined();
        expect((await serviceOf(db, service.id)).status).toBe("terminated");
    });

    /** `past_due` deliberately leaves a machine running: that is the grace. */
    it("asks for nothing at all when an Abo merely goes past due", async () => {
        const { service } = await scenario();
        const fake = fakeProxmox();

        await runCreate(service.id, fake);

        const [item] = await db
            .select()
            .from(schema.subscriptionItem)
            .where(
                eq(
                    schema.subscriptionItem.id,
                    service.subscriptionItemId as string,
                ),
            );

        await transitionSubscription(db, {
            subscriptionId: item.subscriptionId,
            to: "past_due",
            summary: "Überfällig",
            actor: ACTOR,
            at: NOW,
        });

        const tasks = await tasksOf(db, service.id);

        expect(tasks.filter((task) => task.action !== "create")).toEqual([]);
        expect((await serviceOf(db, service.id)).status).toBe("active");
    });

    // --- the create sweep -------------------------------------------------

    it("leaves a manual product alone", async () => {
        const { service } = await scenario({ provisioningMode: "manual" });

        await sweepPendingCreates(db);

        expect(await tasksOf(db, service.id)).toEqual([]);
    });

    /**
     * An unpaid first invoice is not a server. `hasOpenInvoice` asks
     * `OPEN_INVOICE_STATUSES`, so a half-paid one does not qualify either
     * (rule 3).
     */
    it("waits for the first invoice before setting a service up", async () => {
        const { service, order: placed } = await scenario();

        await sweepPendingCreates(db);
        expect(await tasksOf(db, service.id)).toEqual([]);

        const invoice = placed.invoiceId as string;
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoice));
        const gross = row.grossCents as number;

        // Half of it.
        await applyPayment(db, {
            ref: `half-${service.id}`,
            gateway: "banktransfer",
            invoiceId: invoice,
            customerId: service.customerId,
            amountCents: Math.floor(gross / 2),
            actor: ACTOR,
        });

        await sweepPendingCreates(db);
        expect(await tasksOf(db, service.id)).toEqual([]);

        // The rest.
        await applyPayment(db, {
            ref: `rest-${service.id}`,
            gateway: "banktransfer",
            invoiceId: invoice,
            customerId: service.customerId,
            amountCents: gross - Math.floor(gross / 2),
            actor: ACTOR,
        });

        await sweepPendingCreates(db);

        const tasks = await tasksOf(db, service.id);

        expect(tasks).toHaveLength(1);
        expect(tasks[0].action).toBe("create");
    });

    /**
     * The settled payment asks the same question the sweep does, and it has
     * to ask it for itself: unlike the sweep's query, this path starts from
     * an invoice and has to decide per service whether a person was supposed
     * to look at it first.
     */
    it("does not set up a manual product even when it is paid in full", async () => {
        const { service, order: placed } = await scenario({
            provisioningMode: "manual",
        });
        const invoice = placed.invoiceId as string;
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoice));

        await applyPayment(db, {
            ref: `manual-${service.id}`,
            gateway: "banktransfer",
            invoiceId: invoice,
            customerId: service.customerId,
            amountCents: row.grossCents as number,
            actor: ACTOR,
        });

        expect(await provisionAfterSettlement(db, invoice)).toBe(0);
        expect(await tasksOf(db, service.id)).toEqual([]);
    });

    it("queues the create from the settled payment itself", async () => {
        const { service, order: placed } = await scenario();
        const invoice = placed.invoiceId as string;
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoice));
        const gross = row.grossCents as number;

        await applyPayment(db, {
            ref: `full-${service.id}`,
            gateway: "banktransfer",
            invoiceId: invoice,
            customerId: service.customerId,
            amountCents: gross,
            actor: ACTOR,
        });

        const queued = await provisionAfterSettlement(db, invoice);

        expect(queued).toBe(1);

        // And the sweep adds nothing on top: one request, two callers.
        await sweepPendingCreates(db);
        expect(await tasksOf(db, service.id)).toHaveLength(1);
    });

    // --- server choice and credentials ------------------------------------

    it("keeps the API token encrypted and opens it only through one function", async () => {
        const serverId = await makeProxmoxServer(db, { name: "crypto-check" });
        const [row] = await db
            .select()
            .from(schema.provisioningServer)
            .where(eq(schema.provisioningServer.id, serverId));

        expect(row.credentialsEncrypted).toBeTruthy();
        expect(row.credentialsEncrypted).not.toContain("panel@pve");
        expect(serverCredentials(row)).toEqual({
            tokenId: "panel@pve!billing",
            tokenSecret: "a-uuid-looking-secret",
        });
    });

    it("never puts the token in the audit log", async () => {
        const serverId = await makeProxmoxServer(db, { name: "audit-check" });
        const entries = await db
            .select()
            .from(schema.auditLog)
            .where(
                and(
                    eq(schema.auditLog.entityType, "provisioning_server"),
                    eq(schema.auditLog.entityId, serverId),
                ),
            );

        const text = JSON.stringify(entries);

        expect(text).not.toContain("a-uuid-looking-secret");
        expect(text).toContain('"credentials":"set"');
    });

    it("skips a server with no token when choosing where to put something", async () => {
        const naked = await makeProxmoxServer(db, {
            name: "no-token",
            withToken: false,
        });

        const chosen = await chooseServer(db, "proxmox");

        expect(chosen?.id).not.toBe(naked);
    });

    it("aborts without touching anything when no server is usable", async () => {
        const { service } = await scenario({ withToken: false, poolSize: 1 });

        // Make sure no other test's server can be chosen for it.
        await db
            .update(schema.provisioningServer)
            .set({ enabled: false })
            .where(eq(schema.provisioningServer.module, "proxmox"));

        const fake = fakeProxmox();
        const outcome = await runCreate(service.id, fake);

        expect(outcome.ran && outcome.ok).toBe(false);
        expect(fake.calls).toEqual([]);
        expect(await addressesOf(db, service.id)).toEqual([]);

        /**
         * **An installation with no cluster yet is the normal case, not a
         * broken request.** This is what every action does on the day the
         * panel is installed, so it waits — with its attempt given back, so
         * that five minutes of waiting cannot use up a create's whole
         * ladder before the operator has finished reading the setup guide.
         */
        const [task] = await tasksOf(db, service.id);

        expect(task.status).toBe("pending");
        expect(task.attempts).toBe(0);
        expect(outcome.ran && outcome.terminal).toBe(false);

        await db
            .update(schema.provisioningServer)
            .set({ enabled: true })
            .where(eq(schema.provisioningServer.module, "proxmox"));
    });

    it("does nothing at all for a product whose module provisions nothing", async () => {
        const n = next();
        const customerId = await makeCustomer(db, n);
        const groupId = await makeGroup(db, `plain-${n}`);
        const productId = await makeProduct(db, {
            groupId,
            slug: `support-${n}`,
            name: "Supportvertrag",
            cycle: "monthly",
            priceCents: 900,
            type: "subscription",
            provisioningMode: "auto_on_payment",
        });

        await order(db, {
            customerId,
            items: [{ productId, cycle: "monthly" }],
            now: NOW,
            settings: SETTINGS,
        });

        const services = await db
            .select()
            .from(schema.service)
            .where(eq(schema.service.customerId, customerId));

        // Phase 4 gives a `subscription` product no service row at all.
        expect(services).toEqual([]);
    });
});
