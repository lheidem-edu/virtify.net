/**
 * Proxmox VE, over `fetch` and nothing else.
 *
 * No SDK (hard rule 12): this needs a dozen endpoints and one static
 * `Authorization` header, and every published client for PVE would bring its
 * own HTTP stack and a major version to track for that.
 *
 * **Nothing here has ever talked to a real cluster.** There is no Proxmox
 * installation for this panel and no credentials were gone looking for.
 * Everything below is written against the documented PVE API and tested with
 * hand-written payloads (`tests/helpers/proxmox.ts`), which is the same
 * arrangement Phase 7 has for Microsoft Graph — including its lesson: a fake
 * that makes the code's assumptions true by construction tests nothing, so
 * the fake answers in the real API's awkward shapes and the awkward shapes
 * are listed in this header.
 *
 * ## What is awkward about this API, and why it matters
 *
 *  - **Everything is wrapped in `{"data": …}`**, including a `null`.
 *  - **A VMID is a string on the way in and a string on the way out.**
 *    `GET /cluster/nextid` answers `{"data":"101"}`. Parsing it to a number
 *    and formatting it back is a round trip with nothing to gain.
 *  - **Logical errors are 500, and the message is in the HTTP status line,
 *    not in the body.** `POST …/clone` with a `newid` that is taken answers
 *    `500 VM 101 already exists` with a body of `{"data":null}`. A client
 *    that reads only the body learns nothing at all about what went wrong —
 *    which is why `ProxmoxError` carries the status text and why
 *    `alreadyExists` and `missing` are read off it.
 *  - **Mutations are asynchronous and return a UPID.** The clone is not done
 *    when the call returns; it is done when
 *    `GET /nodes/{node}/tasks/{upid}/status` says `status: "stopped"` with
 *    `exitstatus: "OK"`. Anything else is the failure, in words.
 *  - **596 and 599** come from the cluster's own proxy when a node is
 *    unreachable. They are "not yet", not "never".
 *  - **Parameters go out form-encoded**, built by `URLSearchParams` and
 *    nothing else. That is the last line of defence, not the first: every
 *    value is validated into a narrow shape before it gets here (see
 *    `./sanitize.ts`), because a hostname and an SSH key arrive from a
 *    customer's order form.
 *
 * ## TLS
 *
 * A cluster's own certificate is usually self-signed, and Node's global
 * `fetch` takes no per-request TLS options without pulling in undici as a
 * dependency. So the API URL has to present a certificate Node trusts, and
 * the honest way to get there is `NODE_EXTRA_CA_CERTS` pointing at the
 * cluster CA — documented on the server form and in `docs/proxmox-setup.md`.
 * The alternative, a `verifyTls: false` switch, can only be implemented
 * today as `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would turn off
 * certificate checking for Stripe and Microsoft at the same time.
 */

export class ProxmoxError extends Error {
    constructor(
        readonly status: number,
        /** Where the message actually is, for a logical error. */
        readonly statusText: string,
        readonly body: string,
        /** The task's `exitstatus`, when the failure came out of a UPID. */
        readonly exitStatus: string | null = null,
    ) {
        super(
            `Proxmox answered ${status}${statusText ? ` ${statusText}` : ""}` +
                (exitStatus ? ` (Aufgabe: ${exitStatus})` : "") +
                (body ? `: ${body.slice(0, 300)}` : ""),
        );
        this.name = "ProxmoxError";
    }

    /** Everything the cluster said, in one string, for the matchers below. */
    private get text(): string {
        return `${this.statusText} ${this.body} ${this.exitStatus ?? ""}`;
    }

    /**
     * The thing we asked for is already there.
     *
     * **This is a success.** A `create` that timed out and is retried with
     * the same reserved VMID gets exactly this, and treating it as a failure
     * would leave a machine the customer is paying for marked `pending` for
     * ever while the task burns its attempts.
     */
    get alreadyExists(): boolean {
        return /already exists|exists already|bereits vorhanden/i.test(
            this.text,
        );
    }

    /**
     * There is no such machine.
     *
     * Also a success, for `terminate` — and for nothing else. Proxmox says
     * it in several ways depending on which layer refused:
     * `Configuration file 'nodes/pve/qemu-server/101.conf' does not exist`
     * from the config layer, `no such VM` from the status layer.
     */
    get missing(): boolean {
        if (this.status === 404) {
            return true;
        }

        /**
         * **A task that failed is never "already gone".**
         *
         * PVE checks that a VM exists before it starts a job on it, so
         * "there is no such machine" always comes back as the request's own
         * refusal. What comes back through a UPID is the job failing while
         * doing the work — and `qmdestroy` fails with wording like
         * `storage 'local-zfs' does not exist` when the VM references a
         * storage the operator has since removed from `storage.cfg`.
         * Matched as "already gone", that booked a running machine as torn
         * down: the service went `terminated`, its addresses went back into
         * the pool for the next customer, and the VM carried on running
         * with nothing in the panel pointing at it. "Already done is a
         * success" has to mean the machine, and only a refusal can say so.
         */
        if (this.exitStatus !== null) {
            return false;
        }

        return /does not exist|no such vm|not exist|unable to find|nicht vorhanden/i.test(
            this.text,
        );
    }

    /** The token may not do this. Never retried: a token is static. */
    get forbidden(): boolean {
        return (
            this.status === 401 ||
            this.status === 403 ||
            /permission check failed|only root/i.test(this.text)
        );
    }

    /**
     * Not yet, rather than never.
     *
     * 500 is deliberately **not** in here. Proxmox uses it for logical
     * errors — "already exists", "does not exist", "parameter verification
     * failed" — and retrying those is how a client spends four attempts
     * learning the same thing. The transient ones it does report are the
     * proxy's own 59x and the ordinary gateway codes.
     */
    get retryable(): boolean {
        if (this.status === 429 || this.status === 503 || this.status === 504) {
            return true;
        }

        if (this.status === 502 || this.status === 596 || this.status === 599) {
            return true;
        }

        return /too many|try again|connection timed out|connection refused|hostkey verification/i.test(
            this.text,
        );
    }
}

/** A request never reached the cluster. Always "not yet". */
export class ProxmoxUnreachableError extends Error {
    constructor(readonly cause: unknown) {
        super(
            `Der Proxmox-Cluster war nicht erreichbar: ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
        );
        this.name = "ProxmoxUnreachableError";
    }
}

export type ProxmoxCredentials = {
    /** `root@pam!panel` — user, realm and token id, as PVE prints it. */
    tokenId: string;
    /** The UUID PVE showed once, when the token was made. */
    tokenSecret: string;
};

export type ProxmoxClientOptions = {
    /** `https://pve.example.net:8006` — no path, no trailing slash needed. */
    baseUrl: string;
    credentials: ProxmoxCredentials;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    /** How long a single request may take. */
    timeoutMs?: number;
    /** How long to wait for a UPID task to finish before giving up on it. */
    taskTimeoutMs?: number;
};

const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * How long to wait for one PVE job.
 *
 * A `full=1` clone of a template of any real size takes longer than two
 * minutes on NFS, on spinning disks or on a busy Ceph pool, so the first
 * figure here guaranteed that nearly every real create went through the
 * "give up and retry" path. Giving up is now *safe* — the retry sees the
 * clone lock and waits rather than configuring a half-built machine — but
 * it should also be rare, which ten minutes makes it.
 */
const DEFAULT_TASK_TIMEOUT_MS = 600_000;

/** How long to wait before attempt `attempt` (0-based), in ms. */
export function backoffMs(
    retryAfter: string | null,
    attempt: number,
    now: number = Date.now(),
): number {
    if (retryAfter) {
        const seconds = Number(retryAfter);

        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, MAX_BACKOFF_MS);
        }

        const when = Date.parse(retryAfter);

        if (Number.isFinite(when)) {
            return Math.min(Math.max(when - now, 0), MAX_BACKOFF_MS);
        }
    }

    return Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
}

export type NodeCapacity = {
    node: string;
    status: string;
    /** Bytes. */
    maxmem: number;
    mem: number;
    maxdisk: number;
    disk: number;
    maxcpu: number;
    /** Load as a fraction of `maxcpu`, as PVE reports it. */
    cpu: number;
};

export type VmStatus = {
    status: string;
    /** `backup`, `migrate`, `suspended`, or whatever the panel set. */
    lock: string | null;
    uptime: number;
    name: string | null;
    cpus: number | null;
    maxmem: number | null;
    maxdisk: number | null;
};

export type TaskStatus = {
    status: string;
    exitstatus: string | null;
};

export type ProxmoxClient = ReturnType<typeof proxmoxClient>;

export function proxmoxClient(options: ProxmoxClientOptions) {
    const doFetch = options.fetchImpl ?? fetch;
    const sleep =
        options.sleepImpl ??
        ((ms: number) =>
            new Promise<void>((resolve) => {
                setTimeout(resolve, ms);
            }));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const base = `${options.baseUrl.replace(/\/+$/, "")}/api2/json`;

    /**
     * `PVEAPIToken=user@realm!tokenid=secret`.
     *
     * A token is static: it is not refreshed and a 401 on it is a real
     * refusal, so — unlike the Graph client — there is deliberately no
     * re-auth-and-retry here. Retrying a rejected token is how a
     * misconfiguration becomes a request loop against somebody's hypervisor.
     */
    const authorization = `PVEAPIToken=${options.credentials.tokenId}=${options.credentials.tokenSecret}`;

    async function call<T>(
        method: string,
        path: string,
        params?: Record<string, string | number | undefined | null>,
        options: { idempotent?: boolean } = {},
    ): Promise<T> {
        const search = new URLSearchParams();

        for (const [key, value] of Object.entries(params ?? {})) {
            if (value === undefined || value === null) {
                continue;
            }

            search.set(key, String(value));
        }

        const query = search.toString();
        const hasBody = method !== "GET" && method !== "DELETE";
        const url =
            hasBody || query === ""
                ? `${base}${path}`
                : `${base}${path}?${query}`;

        /**
         * Whether this call may be sent a second time.
         *
         * **A retry is a second request, and the cluster cannot tell us
         * whether it ran the first.** For most of these that does not
         * matter: a clone converges on the reserved VMID, a `setConfig`
         * writes the same values, a destroy of something already destroyed
         * is a success. For two of them it matters a great deal — `resize`
         * takes a *delta* (`+60G`), so a repeat leaves the customer with
         * 140 GB of a 80 GB package that Proxmox cannot shrink back; and a
         * power action repeated is a second reboot of a machine whose owner
         * asked for one. The per-action attempt ladder in `tasks.ts` gives
         * those exactly one go, and this loop sat underneath it quietly
         * giving them four.
         */
        const mayRetry = options.idempotent !== false;

        let outcome: {
            status: number;
            statusText: string;
            text: string;
        } | null = null;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            const controller = new AbortController();
            /**
             * The deadline is a promise as well as a signal.
             *
             * Aborting the controller is what a real `fetch` needs to tear
             * the body stream down, but *waiting* for that to happen is
             * trusting somebody else's implementation with the only thing
             * standing between a wedged node and a worker that never runs
             * another task. So the read races the deadline directly, and
             * the abort is the tidy-up rather than the mechanism.
             */
            let fired: () => void = () => undefined;
            const deadline = new Promise<never>((_, reject) => {
                const timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`timed out after ${timeoutMs} ms`));
                }, timeoutMs);

                fired = () => clearTimeout(timer);
            });

            // Nothing is listening for the rejection until the race below.
            deadline.catch(() => undefined);

            const timer = { clear: fired };
            let response: Response;
            let text: string;

            try {
                response = await doFetch(url, {
                    method,
                    headers: {
                        authorization,
                        ...(hasBody
                            ? {
                                  "content-type":
                                      "application/x-www-form-urlencoded",
                              }
                            : {}),
                    },
                    ...(hasBody ? { body: query } : {}),
                    signal: controller.signal,
                });

                /**
                 * **The body is read while the timer is still armed.**
                 *
                 * `fetch` resolves when the *headers* arrive, so a timeout
                 * cleared at that point guards nothing that matters: a
                 * pveproxy that answers `200 OK` and then stops sending —
                 * a node blocked on I/O, a half-closed connection the
                 * kernel never reaps — left `await response.text()` pending
                 * for ever. The provisioning sweep is sequential and the
                 * worker awaits it, so one such call stopped every
                 * create, suspend and terminate on the installation until
                 * somebody killed the process. Which is the exact thing
                 * `timeoutMs` exists to prevent.
                 */
                text = await Promise.race([response.text(), deadline]);
            } catch (error) {
                /**
                 * A refused connection, a DNS failure, our own timeout. None
                 * of those says anything about whether the cluster acted —
                 * which is precisely why `create` reserves the VMID first and
                 * asks afterwards, and why a call that must not run twice
                 * stops here rather than asking again.
                 */
                timer.clear();
                lastError = error;

                if (!mayRetry || attempt === MAX_ATTEMPTS - 1) {
                    throw new ProxmoxUnreachableError(error);
                }

                await sleep(backoffMs(null, attempt));
                continue;
            }

            timer.clear();

            if (response.ok) {
                outcome = {
                    status: response.status,
                    statusText: response.statusText,
                    text,
                };
                break;
            }

            const transient = new ProxmoxError(
                response.status,
                response.statusText,
                text,
            ).retryable;

            if (transient && mayRetry && attempt < MAX_ATTEMPTS - 1) {
                await sleep(
                    backoffMs(response.headers.get("retry-after"), attempt),
                );
                continue;
            }

            outcome = {
                status: response.status,
                statusText: response.statusText,
                text,
            };
            break;
        }

        if (!outcome) {
            throw new ProxmoxUnreachableError(lastError);
        }

        if (outcome.status < 200 || outcome.status >= 300) {
            throw new ProxmoxError(
                outcome.status,
                outcome.statusText,
                outcome.text,
            );
        }

        /**
         * An empty body is a success. The same lesson Phase 7 paid for: some
         * of these answer `200` with nothing at all, and keying the parse on
         * a status code made the most important call in that system throw
         * after the work had already been done.
         */
        if (outcome.text.trim() === "") {
            return undefined as T;
        }

        const parsed = JSON.parse(outcome.text) as { data?: T };

        return parsed.data as T;
    }

    /**
     * Waits for a UPID to finish, and turns anything but `OK` into the error
     * the cluster described.
     *
     * A task that is still running when the deadline passes throws a
     * *retryable* error: the clone may well finish a second later, and the
     * next attempt asks the cluster whether the VM exists rather than asking
     * for it again.
     */
    async function waitForTask(
        node: string,
        upid: string,
    ): Promise<TaskStatus> {
        const deadline = Date.now() + taskTimeoutMs;
        let attempt = 0;

        for (;;) {
            const status = await call<TaskStatus>(
                "GET",
                `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(
                    upid,
                )}/status`,
            );

            if (status?.status === "stopped") {
                if ((status.exitstatus ?? "").toUpperCase() !== "OK") {
                    throw new ProxmoxError(
                        500,
                        status.exitstatus ?? "task failed",
                        "",
                        status.exitstatus ?? null,
                    );
                }

                return status;
            }

            if (Date.now() >= deadline) {
                throw new ProxmoxError(
                    504,
                    `task ${upid} still running — try again`,
                    "",
                );
            }

            await sleep(backoffMs(null, attempt));
            attempt += 1;
        }
    }

    const qemu = (node: string, vmid: string) =>
        `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}`;

    return {
        /** `GET /version` — the cheapest proof that the token works. */
        async version(): Promise<{ version: string; release: string }> {
            return call("GET", "/version");
        },

        async nodes(): Promise<NodeCapacity[]> {
            const rows = await call<Partial<NodeCapacity>[]>("GET", "/nodes");

            return (rows ?? []).map((row) => ({
                node: String(row.node ?? ""),
                status: String(row.status ?? "unknown"),
                maxmem: Number(row.maxmem ?? 0),
                mem: Number(row.mem ?? 0),
                maxdisk: Number(row.maxdisk ?? 0),
                disk: Number(row.disk ?? 0),
                maxcpu: Number(row.maxcpu ?? 0),
                cpu: Number(row.cpu ?? 0),
            }));
        },

        /**
         * The node a VMID is on right now, or null when the cluster has
         * never heard of it.
         *
         * `GET /cluster/resources?type=vm` is the only question that can
         * tell "this machine was migrated" from "this machine is gone", and
         * the difference decides whether a customer's addresses go back
         * into the pool.
         */
        async findVm(vmid: string): Promise<string | null> {
            const rows = await call<Record<string, unknown>[]>(
                "GET",
                "/cluster/resources",
                { type: "vm" },
            );

            const row = (rows ?? []).find(
                (entry) => String(entry.vmid ?? "") === String(vmid),
            );

            return row?.node ? String(row.node) : null;
        },

        /** `GET /cluster/nextid` — a string, and it stays one. */
        async nextId(): Promise<string> {
            const value = await call<string | number>("GET", "/cluster/nextid");

            return String(value);
        },

        async clone(input: {
            node: string;
            templateVmid: string;
            newId: string;
            name: string;
            targetNode?: string | null;
            storage?: string | null;
            full?: boolean;
            pool?: string | null;
            description?: string | null;
        }): Promise<string> {
            const upid = await call<string>(
                "POST",
                `${qemu(input.node, input.templateVmid)}/clone`,
                {
                    newid: input.newId,
                    name: input.name,
                    target: input.targetNode ?? undefined,
                    storage: input.storage ?? undefined,
                    full: input.full === false ? 0 : 1,
                    pool: input.pool ?? undefined,
                    description: input.description ?? undefined,
                },
            );

            await waitForTask(input.node, upid);

            return upid;
        },

        /** `PUT …/config` — the synchronous form. Takes already-safe values. */
        async setConfig(
            node: string,
            vmid: string,
            params: Record<string, string | number | undefined | null>,
        ): Promise<void> {
            await call("PUT", `${qemu(node, vmid)}/config`, params);
        },

        async resizeDisk(
            node: string,
            vmid: string,
            disk: string,
            size: string,
        ): Promise<void> {
            /**
             * `size` is a delta — `+60G`, not "make it 80G" — so this is
             * the one call in the module that must never be sent twice.
             * Proxmox cannot shrink a disk back.
             */
            await call(
                "PUT",
                `${qemu(node, vmid)}/resize`,
                { disk, size },
                { idempotent: false },
            );
        },

        async status(node: string, vmid: string): Promise<VmStatus> {
            const row = await call<Record<string, unknown>>(
                "GET",
                `${qemu(node, vmid)}/status/current`,
            );

            return {
                status: String(row?.status ?? "unknown"),
                lock: row?.lock ? String(row.lock) : null,
                uptime: Number(row?.uptime ?? 0),
                name: row?.name ? String(row.name) : null,
                cpus: row?.cpus === undefined ? null : Number(row.cpus),
                maxmem: row?.maxmem === undefined ? null : Number(row.maxmem),
                maxdisk:
                    row?.maxdisk === undefined ? null : Number(row.maxdisk),
            };
        },

        /**
         * `start` | `stop` | `shutdown` | `reboot` | `resume`.
         *
         * The UPID is awaited for everything but `shutdown` and `reboot`,
         * which wait on the guest's own ACPI handler and can sit there for
         * as long as the guest likes. Holding a request open for that is the
         * panel's problem, not the customer's: the task is recorded, the
         * next `sync` reports what actually happened.
         */
        async power(
            node: string,
            vmid: string,
            what: "start" | "stop" | "shutdown" | "reboot" | "resume",
            opts: { wait?: boolean } = {},
        ): Promise<string> {
            const upid = await call<string>(
                "POST",
                `${qemu(node, vmid)}/status/${what}`,
                undefined,
                /**
                 * A reboot is not idempotent, and neither is a `stop` on a
                 * guest that was already shutting down. The attempt ladder
                 * gives a power action exactly one go for that reason; this
                 * is the same decision one layer down.
                 */
                { idempotent: false },
            );

            const wait =
                opts.wait ?? (what !== "shutdown" && what !== "reboot");

            if (wait && upid) {
                await waitForTask(node, upid);
            }

            return upid;
        },

        async destroy(
            node: string,
            vmid: string,
            opts: { purge?: boolean } = {},
        ): Promise<string> {
            const upid = await call<string>(
                "DELETE",
                `${qemu(node, vmid)}?purge=${opts.purge === false ? 0 : 1}` +
                    `&destroy-unreferenced-disks=1`,
            );

            if (upid) {
                await waitForTask(node, upid);
            }

            return upid;
        },

        async vncProxy(
            node: string,
            vmid: string,
        ): Promise<{ ticket: string; port: string; user: string }> {
            const row = await call<Record<string, unknown>>(
                "POST",
                `${qemu(node, vmid)}/vncproxy`,
                { websocket: 1 },
            );

            return {
                ticket: String(row?.ticket ?? ""),
                port: String(row?.port ?? ""),
                user: String(row?.user ?? ""),
            };
        },

        /** Exposed for the places that need a raw call, and for tests. */
        call,
        waitForTask,
    };
}
