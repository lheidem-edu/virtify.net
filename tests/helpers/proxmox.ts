/**
 * A Proxmox VE cluster made of hand-written answers.
 *
 * There is no cluster for this installation and no credentials were gone
 * looking for, so every test drives the module through this instead of
 * through a hypervisor. It records what it was asked to do — what was cloned,
 * what was configured, what was destroyed — because half the claims worth
 * making about the module are claims about *that*.
 *
 * ## It answers like the real thing, including where that is inconvenient
 *
 * Phase 7's lesson, in its own words: *a fake that makes the code's
 * assumptions true by construction tests nothing.* That phase shipped a
 * `/send` keyed on 204 when Graph answers 202 with an empty body, and the
 * fake hid it until the review. So this one reproduces the PVE API's awkward
 * shapes on purpose:
 *
 *  - every answer is wrapped in `{"data": …}`, including a bare string and a
 *    `null`;
 *  - `GET /cluster/nextid` answers with a **string**, `"101"`, not a number;
 *  - a mutation answers with a **UPID**, and the work is not finished until
 *    `GET /nodes/{node}/tasks/{upid}/status` says `stopped` with
 *    `exitstatus: "OK"` — and the first poll deliberately says `running`, so
 *    a client that does not poll fails here rather than in production;
 *  - a **logical error is a 500 whose message is in the HTTP status line**,
 *    with `{"data":null}` in the body. Cloning onto a VMID that exists
 *    answers `500 VM 101 already exists`; touching a VM that does not exist
 *    answers `500 Configuration file 'nodes/pve1/qemu-server/101.conf' does
 *    not exist`. A client that reads only the body learns nothing;
 *  - setting `lock` answers **403** for a restricted token, which is what the
 *    setup guide asks operators to create;
 *  - a throttled request answers 429 with `Retry-After`.
 *
 * Request bodies are form-encoded and are parsed back into
 * `calls[].params`, so a test can assert what `ipconfig0`, `sshkeys` and
 * `cipassword` actually carried.
 */

export type RecordedCall = {
    method: string;
    path: string;
    params: Record<string, string>;
};

export type FakeVm = {
    vmid: string;
    node: string;
    name: string;
    status: "running" | "stopped";
    lock: string | null;
    maxdisk: number;
    cores: number;
    memory: number;
    config: Record<string, string>;
};

export type FakeProxmoxOptions = {
    nodes?: {
        node: string;
        status?: string;
        maxmem?: number;
        mem?: number;
        maxcpu?: number;
        cpu?: number;
        maxdisk?: number;
        disk?: number;
    }[];
    /** VMs that already exist, keyed by vmid. The template goes in here too. */
    vms?: FakeVm[];
    /** The id `GET /cluster/nextid` hands out, then that plus one, and so on. */
    nextId?: number;
    /** A token that may not set `lock`, which is the documented normal case. */
    restrictedToken?: boolean;
    /** Answer this many requests with 429 before getting on with it. */
    throttleFirst?: number;
    /** Paths (substring match) that answer with a network failure. */
    unreachable?: string[];
    /** Paths (substring match) that answer 500 with this status line. */
    failWith?: Record<string, string>;
    /** How many task polls report `running` before reporting `stopped`. */
    taskPolls?: number;
    /**
     * VMIDs whose **first** `status/current` reports "does not exist" even
     * though the VM is there.
     *
     * Not contrived: `status/current` goes through the cluster proxy to a
     * node, and a config that has just been written is briefly not visible
     * from every node. It is also the only way to reach the branch where the
     * clone is asked for a second time and PVE refuses it with
     * `500 VM 101 already exists` — which is the answer the whole create
     * path turns on.
     */
    missingOnce?: string[];
    version?: string;
};

export type FakeProxmox = {
    fetchImpl: typeof fetch;
    readonly calls: RecordedCall[];
    readonly vms: Map<string, FakeVm>;
    /** Convenience: every call to a path containing this fragment. */
    callsTo(fragment: string): RecordedCall[];
    /** The VM by id, or a failure that names it — tests assert on this. */
    vm(vmid: string): FakeVm;
    /** The last form parameters sent to a path containing this fragment. */
    paramsFor(fragment: string): Record<string, string> | null;
    sleep: (ms: number) => Promise<void>;
    readonly slept: number[];
};

export function fakeVm(over: Partial<FakeVm> = {}): FakeVm {
    return {
        vmid: "9000",
        node: "pve1",
        name: "debian-13-cloud",
        status: "stopped",
        lock: null,
        maxdisk: 10 * 1024 ** 3,
        cores: 1,
        memory: 512,
        config: {},
        ...over,
    };
}

const MISSING = (node: string, vmid: string) =>
    `Configuration file 'nodes/${node}/qemu-server/${vmid}.conf' does not exist`;

function json(data: unknown, status = 200, statusText = "OK"): Response {
    return new Response(JSON.stringify({ data }), {
        status,
        statusText,
        headers: { "content-type": "application/json" },
    });
}

/** A logical error: 500, the message in the status line, `{"data":null}`. */
function logicalError(message: string): Response {
    return new Response(JSON.stringify({ data: null }), {
        status: 500,
        statusText: message,
        headers: { "content-type": "application/json" },
    });
}

export function fakeProxmox(options: FakeProxmoxOptions = {}): FakeProxmox {
    const calls: RecordedCall[] = [];
    const slept: number[] = [];
    const vms = new Map<string, FakeVm>(
        (options.vms ?? [fakeVm()]).map((vm) => [vm.vmid, vm]),
    );
    const nodes = options.nodes ?? [
        {
            node: "pve1",
            status: "online",
            maxmem: 64 * 1024 ** 3,
            mem: 8 * 1024 ** 3,
            maxcpu: 32,
            cpu: 0.2,
            maxdisk: 100 * 1024 ** 3,
            disk: 30 * 1024 ** 3,
        },
    ];

    let nextId = options.nextId ?? 101;
    let throttleLeft = options.throttleFirst ?? 0;
    /** UPID → how many more polls say `running`. */
    const tasks = new Map<string, { left: number; ok: boolean }>();
    let upidCounter = 0;
    const pretendedMissing = new Set<string>();

    function upid(node: string, kind: string, vmid: string): string {
        upidCounter += 1;

        const id = `UPID:${node}:0000${upidCounter}:00000000:00000000:${kind}:${vmid}:panel@pve:`;

        tasks.set(id, { left: options.taskPolls ?? 1, ok: true });

        return id;
    }

    const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        const url = new URL(
            typeof input === "string" ? input : input.toString(),
        );
        const method = (init?.method ?? "GET").toUpperCase();
        const path = url.pathname.replace("/api2/json", "") + url.search;

        const params: Record<string, string> = {};

        if (typeof init?.body === "string") {
            for (const [key, value] of new URLSearchParams(init.body)) {
                params[key] = value;
            }
        }

        calls.push({ method, path, params });

        for (const fragment of options.unreachable ?? []) {
            if (path.includes(fragment)) {
                throw new TypeError("fetch failed");
            }
        }

        if (throttleLeft > 0) {
            throttleLeft -= 1;

            return new Response(JSON.stringify({ data: null }), {
                status: 429,
                statusText: "Too many requests",
                headers: { "retry-after": "1" },
            });
        }

        for (const [fragment, message] of Object.entries(
            options.failWith ?? {},
        )) {
            if (path.includes(fragment)) {
                return logicalError(message);
            }
        }

        if (!(init?.headers as Record<string, string>)?.authorization) {
            return new Response(JSON.stringify({ data: null }), {
                status: 401,
                statusText: "authentication failure",
            });
        }

        if (path === "/version") {
            return json({
                version: options.version ?? "8.3.0",
                release: "8.3",
                repoid: "deadbeef",
            });
        }

        if (path === "/nodes") {
            return json(nodes);
        }

        if (path === "/cluster/nextid") {
            // A string, as PVE really answers.
            const id = String(nextId);

            nextId += 1;

            return json(id);
        }

        const taskMatch = path.match(
            /^\/nodes\/([^/]+)\/tasks\/([^/]+)\/status/,
        );

        if (taskMatch) {
            const id = decodeURIComponent(taskMatch[2]);
            const state = tasks.get(id);

            if (!state) {
                return logicalError(`no such task '${id}'`);
            }

            if (state.left > 0) {
                state.left -= 1;

                return json({ status: "running", upid: id });
            }

            return json({
                status: "stopped",
                exitstatus: state.ok ? "OK" : "clone failed: disk full",
                upid: id,
            });
        }

        const vmMatch = path.match(/^\/nodes\/([^/]+)\/qemu\/([^/?]+)(.*)$/);

        if (!vmMatch) {
            return logicalError(`no such resource '${path}'`);
        }

        const [, node, vmid, rest] = vmMatch;
        const vm = vms.get(vmid);

        if (
            rest.startsWith("/status/current") &&
            (options.missingOnce ?? []).includes(vmid) &&
            !pretendedMissing.has(vmid)
        ) {
            pretendedMissing.add(vmid);

            return logicalError(MISSING(node, vmid));
        }

        if (rest.startsWith("/clone")) {
            if (!vm) {
                return logicalError(MISSING(node, vmid));
            }

            const newId = params.newid;

            if (vms.has(newId)) {
                /**
                 * **The answer the whole create path turns on.** PVE refuses
                 * a duplicate `newid` with a 500 whose message lives in the
                 * status line — so a retry of a create whose first clone did
                 * go through lands here, and the module has to read it as a
                 * success.
                 */
                return logicalError(`VM ${newId} already exists`);
            }

            vms.set(newId, {
                vmid: newId,
                node: params.target || node,
                name: params.name ?? `vm-${newId}`,
                status: "stopped",
                lock: null,
                maxdisk: vm.maxdisk,
                cores: vm.cores,
                memory: vm.memory,
                config: {},
            });

            return json(upid(node, "qmclone", vmid));
        }

        if (!vm) {
            return logicalError(MISSING(node, vmid));
        }

        if (rest.startsWith("/config")) {
            if (method !== "PUT" && method !== "POST") {
                return json(vm.config);
            }

            if ("lock" in params && options.restrictedToken) {
                return new Response(JSON.stringify({ data: null }), {
                    status: 403,
                    /**
                     * ASCII only: `statusText` is a ByteString, and a
                     * Response built with an em dash in it throws before the
                     * client ever sees the 403. PVE's own message is ASCII.
                     */
                    statusText:
                        "Permission check failed (/, VM.Config.Options) - only root@pam may set lock",
                });
            }

            Object.assign(vm.config, params);

            if (params.cores) {
                vm.cores = Number(params.cores);
            }

            if (params.memory) {
                vm.memory = Number(params.memory);
            }

            if (params.name) {
                vm.name = params.name;
            }

            if ("lock" in params) {
                vm.lock = params.lock === "" ? null : params.lock;
            }

            // PVE answers a synchronous config change with `{"data":null}`.
            return json(null);
        }

        if (rest.startsWith("/resize")) {
            const size = params.size ?? "";
            const grow = Number(size.replace(/^\+/, "").replace(/G$/i, ""));

            if (Number.isFinite(grow)) {
                vm.maxdisk += grow * 1024 ** 3;
            }

            return json(null);
        }

        if (rest.startsWith("/status/current")) {
            return json({
                status: vm.status,
                ...(vm.lock ? { lock: vm.lock } : {}),
                uptime: vm.status === "running" ? 259_200 : 0,
                name: vm.name,
                vmid: Number(vm.vmid),
                cpus: vm.cores,
                maxmem: vm.memory * 1024 ** 2,
                maxdisk: vm.maxdisk,
            });
        }

        if (rest.startsWith("/status/")) {
            const what = rest.slice("/status/".length).split("?")[0];

            if (what === "start" || what === "resume") {
                vm.status = "running";
            }

            if (what === "stop" || what === "shutdown") {
                vm.status = "stopped";
            }

            if (what === "reboot") {
                vm.status = "running";
            }

            return json(upid(node, `qm${what}`, vmid));
        }

        if (rest.startsWith("/vncproxy")) {
            return json({
                ticket: "PVEVNC:deadbeef",
                port: "5900",
                user: "panel@pve",
                cert: "-----BEGIN CERTIFICATE-----",
                upid: upid(node, "vncproxy", vmid),
            });
        }

        if (method === "DELETE") {
            vms.delete(vmid);

            return json(upid(node, "qmdestroy", vmid));
        }

        return logicalError(`no such resource '${path}'`);
    }) as typeof fetch;

    return {
        fetchImpl,
        calls,
        vms,
        callsTo(fragment) {
            return calls.filter((call) => call.path.includes(fragment));
        },
        vm(vmid) {
            const found = vms.get(vmid);

            if (!found) {
                throw new Error(
                    `the fake cluster has no VM ${vmid} (it has ${[
                        ...vms.keys(),
                    ].join(", ")})`,
                );
            }

            return found;
        },
        paramsFor(fragment) {
            const matching = calls.filter((call) =>
                call.path.includes(fragment),
            );

            return matching[matching.length - 1]?.params ?? null;
        },
        slept,
        sleep: async (ms: number) => {
            slept.push(ms);
        },
    };
}
