import { describe, expect, it } from "vitest";
import {
    backoffMs,
    ProxmoxError,
    ProxmoxUnreachableError,
    proxmoxClient,
} from "@/server/provisioning/proxmox/api";
import { fakeProxmox, fakeVm } from "../helpers/proxmox";

/**
 * The HTTP client, against a fake that answers in the real API's shapes.
 *
 * What is being tested here is almost entirely "does the client read the
 * answer the way Proxmox actually gives it" — the `{"data": …}` wrapper, a
 * VMID that is a string, a UPID that has to be polled, and above all a
 * logical error that is a 500 with the message in the HTTP status line.
 */

function client(fake: ReturnType<typeof fakeProxmox>) {
    return proxmoxClient({
        baseUrl: "https://pve.example.net:8006",
        credentials: {
            tokenId: "panel@pve!billing",
            tokenSecret: "s3cret-uuid-value",
        },
        fetchImpl: fake.fetchImpl,
        sleepImpl: fake.sleep,
    });
}

describe("the Proxmox HTTP client", () => {
    it("sends a PVEAPIToken header and unwraps `data`", async () => {
        const fake = fakeProxmox();
        const version = await client(fake).version();

        expect(version.version).toBe("8.3.0");
    });

    it("hands back the VMID as the string PVE sent", async () => {
        const fake = fakeProxmox({ nextId: 101 });
        const id = await client(fake).nextId();

        // Not 101. A VMID is a string on the way in and out; parsing it to a
        // number and formatting it back is a round trip with nothing to gain.
        expect(id).toBe("101");
        expect(typeof id).toBe("string");
    });

    it("waits for a clone's UPID before calling it done", async () => {
        const fake = fakeProxmox({ taskPolls: 2 });

        await client(fake).clone({
            node: "pve1",
            templateVmid: "9000",
            newId: "101",
            name: "vps-101",
        });

        // Two polls that said `running`, then one that said OK.
        expect(fake.callsTo("/tasks/").length).toBe(3);
        expect(fake.vms.get("101")?.name).toBe("vps-101");
    });

    it("builds the clone body form-encoded, with full=1 by default", async () => {
        const fake = fakeProxmox();

        await client(fake).clone({
            node: "pve1",
            templateVmid: "9000",
            newId: "101",
            name: "vps-101",
            targetNode: "pve2",
            storage: "local-zfs",
        });

        expect(fake.paramsFor("/clone")).toMatchObject({
            newid: "101",
            name: "vps-101",
            target: "pve2",
            storage: "local-zfs",
            full: "1",
        });
    });

    it("leaves out parameters that are null rather than sending 'null'", async () => {
        const fake = fakeProxmox();

        await client(fake).clone({
            node: "pve1",
            templateVmid: "9000",
            newId: "101",
            name: "vps-101",
            targetNode: null,
            storage: null,
            pool: null,
        });

        const params = fake.paramsFor("/clone");

        expect(params).not.toHaveProperty("target");
        expect(params).not.toHaveProperty("storage");
        expect(params).not.toHaveProperty("pool");
    });

    /**
     * The one that matters most. PVE puts the message in the HTTP status
     * line and `{"data":null}` in the body, so a client that reads only the
     * body cannot tell "already exists" from "disk full".
     */
    it("reads a logical error out of the status line, not the body", async () => {
        const fake = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101", name: "vps-101" })],
        });

        await expect(
            client(fake).clone({
                node: "pve1",
                templateVmid: "9000",
                newId: "101",
                name: "vps-101",
            }),
        ).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof ProxmoxError && error.alreadyExists,
        );
    });

    it("recognises a missing VM however PVE words it", () => {
        const fromConfig = new ProxmoxError(
            500,
            "Configuration file 'nodes/pve1/qemu-server/101.conf' does not exist",
            "",
        );
        const fromStatus = new ProxmoxError(500, "no such VM ('101')", "");
        const notFound = new ProxmoxError(404, "Not Found", "");

        expect(fromConfig.missing).toBe(true);
        expect(fromStatus.missing).toBe(true);
        expect(notFound.missing).toBe(true);
        expect(new ProxmoxError(500, "disk full", "").missing).toBe(false);
    });

    /**
     * 500 is PVE's code for a *logical* error — "already exists", "does not
     * exist", "parameter verification failed". Retrying those spends four
     * attempts learning the same thing.
     */
    it("does not retry a 500", async () => {
        const fake = fakeProxmox({
            failWith: { "/status/current": "parameter verification failed" },
        });

        await expect(client(fake).status("pve1", "101")).rejects.toThrow(
            ProxmoxError,
        );
        expect(fake.callsTo("/status/current").length).toBe(1);
        expect(fake.slept).toEqual([]);
    });

    it("honours Retry-After on a 429 and then succeeds", async () => {
        const fake = fakeProxmox({ throttleFirst: 2 });
        const version = await client(fake).version();

        expect(version.version).toBe("8.3.0");
        // 1 second, as the header said — twice.
        expect(fake.slept).toEqual([1000, 1000]);
    });

    it("treats the cluster proxy's 596 as 'not yet'", () => {
        expect(new ProxmoxError(596, "Connection refused", "").retryable).toBe(
            true,
        );
        expect(new ProxmoxError(599, "", "").retryable).toBe(true);
        expect(
            new ProxmoxError(403, "Permission check failed", "").retryable,
        ).toBe(false);
    });

    it("never retries a rejected token", () => {
        const error = new ProxmoxError(401, "authentication failure", "");

        expect(error.forbidden).toBe(true);
        expect(error.retryable).toBe(false);
    });

    it("reports an unreachable cluster as its own error", async () => {
        const fake = fakeProxmox({ unreachable: ["/version"] });

        await expect(client(fake).version()).rejects.toThrow(
            ProxmoxUnreachableError,
        );
        // Four attempts, three backoffs.
        expect(fake.slept.length).toBe(3);
    });

    it("turns a task that ends badly into the cluster's own words", async () => {
        const fake = fakeProxmox();
        const api = client(fake);

        // Drive a UPID whose task the fake does not know: PVE answers 500.
        await expect(api.waitForTask("pve1", "UPID:bogus")).rejects.toThrow(
            /no such task/,
        );
    });

    it("reads an empty body as success", async () => {
        const fake = fakeProxmox();

        // `PUT …/config` answers `{"data":null}`; a client that insisted on a
        // parsable payload would throw after the change had been made.
        await expect(
            client(fake).setConfig("pve1", "9000", { cores: 2 }),
        ).resolves.toBeUndefined();
        expect(fake.vms.get("9000")?.cores).toBe(2);
    });

    it("purges disks on destroy, so a cancelled customer frees storage", async () => {
        const fake = fakeProxmox({
            vms: [fakeVm(), fakeVm({ vmid: "101" })],
        });

        await client(fake).destroy("pve1", "101");

        const call = fake.callsTo("qemu/101?")[0];

        expect(call.path).toContain("purge=1");
        expect(call.path).toContain("destroy-unreferenced-disks=1");
        expect(fake.vms.has("101")).toBe(false);
    });

    it("does not wait on a shutdown, which waits on the guest", async () => {
        const fake = fakeProxmox({ taskPolls: 5 });

        await client(fake).power("pve1", "9000", "shutdown");

        expect(fake.callsTo("/tasks/")).toEqual([]);
    });

    it("does wait on a stop, which the hypervisor does itself", async () => {
        const fake = fakeProxmox({ taskPolls: 1 });

        await client(fake).power("pve1", "9000", "stop");

        expect(fake.callsTo("/tasks/").length).toBe(2);
    });
});

describe("backoff", () => {
    it("honours a Retry-After in seconds", () => {
        expect(backoffMs("3", 0)).toBe(3_000);
    });

    it("honours a Retry-After as an HTTP date", () => {
        const now = Date.parse("2026-11-09T12:00:00.000Z");

        expect(backoffMs("Mon, 09 Nov 2026 12:00:05 GMT", 0, now)).toBe(5_000);
    });

    it("never waits longer than the cap, whatever the header says", () => {
        expect(backoffMs("3600", 0)).toBe(15_000);
    });

    it("never waits a negative time for a date in the past", () => {
        const now = Date.parse("2026-11-09T12:00:00.000Z");

        expect(backoffMs("Mon, 09 Nov 2026 11:59:00 GMT", 0, now)).toBe(0);
    });

    it("backs off exponentially when the cluster says nothing", () => {
        expect(backoffMs(null, 0)).toBe(500);
        expect(backoffMs(null, 1)).toBe(1_000);
        expect(backoffMs(null, 2)).toBe(2_000);
        expect(backoffMs(null, 20)).toBe(15_000);
    });
});
