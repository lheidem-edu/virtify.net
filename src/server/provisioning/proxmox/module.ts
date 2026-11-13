import { z } from "zod";
import type {
    ConnectionCheck,
    ConsoleTicket,
    ModuleContext,
    ModuleResult,
    ProviderStatus,
    ProvisioningModule,
} from "../types";
import {
    type NodeCapacity,
    type ProxmoxClient,
    ProxmoxError,
    ProxmoxUnreachableError,
    proxmoxClient,
} from "./api";
import { selectNode } from "./nodes";
import {
    assertUnits,
    generatePassword,
    hostSuffix,
    type IpConfigInput,
    ipConfigValue,
    nameserverValue,
    ProvisioningInputError,
    parseSshKeys,
    toHostname,
} from "./sanitize";

/**
 * Proxmox VE: a VM per service, cloned from a template.
 *
 * **No cluster exists for this installation and no credentials were gone
 * looking for.** Everything here is written against the documented PVE API
 * and driven in tests by a fake that answers in the real API's shapes
 * (`tests/helpers/proxmox.ts`). The list of what is awkward about that API —
 * `{"data": …}` around everything, string VMIDs, logical errors as `500`
 * with the message in the HTTP status line, UPIDs for every mutation — is in
 * `./api.ts`, because getting any of those wrong is how Phase 7 shipped a
 * `/send` that threw after the mail had gone out.
 *
 * ## The two decisions worth reading before the code
 *
 * **1. The VMID is ours.** `GET /cluster/nextid` is asked once, the answer is
 * written to `provisioning_resource` *before* the clone, and the clone is
 * asked for with `newid=` that value. That is what makes a create safe to
 * retry: the retry asks the cluster whether VM 101 exists and either finds
 * it (already done, success) or clones again under the same id — and if the
 * first clone did in fact go through, Proxmox itself refuses the second with
 * `500 VM 101 already exists`, which is read as the same success. Without a
 * reserved id the only question a retry could ask is "did my request arrive",
 * which the network cannot answer, and the answer it guesses wrong is a
 * second VM the customer is not paying for.
 *
 * **2. Suspension is `stop` plus `onboot=0`, and the `lock` is a second
 * belt.** The build plan asks for "stop + lock". Setting `lock` through the
 * API is restricted to `root@pam` on a normal PVE installation, so a panel
 * that treats the lock as the suspension has a suspension that silently does
 * not happen the moment the operator follows our own advice and uses a
 * restricted token. `onboot=0` needs no privilege and is the part that
 * actually matters: without it the next host reboot brings a suspended
 * customer's machine back. The lock is attempted when the server is
 * configured for it, and a refusal is a **warning on the task**, not a
 * failure — the machine is stopped either way.
 */

const MODULE_ID = "proxmox";

/**
 * What the operator configures per product. Cores and memory are per unit
 * ordered; one service is one machine.
 */
export const proxmoxConfigSchema = z
    .object({
        cores: z.number().int().min(1).max(128).default(1),
        memoryMiB: z.number().int().min(128).max(1_048_576).default(1024),
        diskGiB: z.number().int().min(1).max(32_768).default(20),

        /** Overrides the server's template, for a product on a different OS. */
        templateVmid: z.string().trim().max(16).nullish(),
        templateNode: z.string().trim().max(64).nullish(),

        /** Overrides the server's storage, for a product on faster disks. */
        storage: z.string().trim().max(64).nullish(),

        ipv4Count: z.number().int().min(0).max(16).default(1),
        ipv6Count: z.number().int().min(0).max(16).default(0),
        /** A specific pool, or null for any enabled pool on the server. */
        ipv4PoolId: z.string().trim().max(64).nullish(),
        ipv6PoolId: z.string().trim().max(64).nullish(),

        /** The cloud-init user. `root` for the Debian/Ubuntu cloud images. */
        osUser: z
            .string()
            .trim()
            .regex(/^[a-z_][a-z0-9_-]{0,31}$/, "Kein gültiger Benutzername")
            .default("root"),

        /**
         * `{label}` is the sanitised service label, `{id}` the VMID.
         * Whatever comes out goes through `toHostname()` regardless.
         */
        hostnamePattern: z.string().trim().max(120).default("{label}-{id}"),

        /** Start the machine when the host boots. Cleared by a suspension. */
        onboot: z.boolean().default(true),

        /** Let the customer run containers inside their VM. */
        nesting: z.boolean().default(false),
    })
    .transform((value) => ({
        cores: value.cores ?? 1,
        memoryMiB: value.memoryMiB ?? 1024,
        diskGiB: value.diskGiB ?? 20,
        templateVmid: value.templateVmid ?? null,
        templateNode: value.templateNode ?? null,
        storage: value.storage ?? null,
        ipv4Count: value.ipv4Count ?? 1,
        ipv6Count: value.ipv6Count ?? 0,
        ipv4PoolId: value.ipv4PoolId ?? null,
        ipv6PoolId: value.ipv6PoolId ?? null,
        osUser: value.osUser ?? "root",
        hostnamePattern: value.hostnamePattern ?? "{label}-{id}",
        onboot: value.onboot ?? true,
        nesting: value.nesting ?? false,
    }));

export type ProxmoxConfig = z.infer<typeof proxmoxConfigSchema>;

export const proxmoxServerSchema = z
    .object({
        /** `https://pve.example.net:8006`. See `./api.ts` on TLS. */
        apiUrl: z
            .string()
            .trim()
            .url("Das ist keine URL")
            .refine(
                (value) => value.startsWith("https://"),
                "Die API-Adresse muss https sein.",
            ),

        /** The template to clone, and the node it lives on. */
        templateVmid: z.string().trim().min(1).max(16),
        templateNode: z.string().trim().min(1).max(64),

        /** Only these nodes may be chosen. Empty means every online node. */
        nodes: z.array(z.string().trim().min(1).max(64)).default([]),
        excludeNodes: z.array(z.string().trim().min(1).max(64)).default([]),

        storage: z.string().trim().max(64).nullish(),
        bridge: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9]{0,14}$/, "Keine gültige Bridge")
            .default("vmbr0"),
        vlanTag: z.number().int().min(1).max(4094).nullish(),
        pool: z.string().trim().max(64).nullish(),

        /** The disk cloud-init resizes. `scsi0` for the cloud images. */
        diskBus: z
            .string()
            .trim()
            .regex(/^(scsi|virtio|sata|ide)\d$/, "Kein gültiger Datenträger")
            .default("scsi0"),

        searchDomain: z.string().trim().max(120).nullish(),

        /**
         * Try to set `lock` on a suspended machine. Off by default, because
         * it needs `root@pam` and the whole point of the setup guide is a
         * restricted token — see the module header.
         */
        lockOnSuspend: z.boolean().default(false),
    })
    .transform((value) => ({
        ...value,
        nodes: value.nodes ?? [],
        excludeNodes: value.excludeNodes ?? [],
        storage: value.storage ?? null,
        vlanTag: value.vlanTag ?? null,
        pool: value.pool ?? null,
        searchDomain: value.searchDomain ?? null,
    }));

export type ProxmoxServerConfig = z.infer<typeof proxmoxServerSchema>;

export const proxmoxCredentialsSchema = z.object({
    /** `panel@pve!billing`, exactly as PVE prints it. */
    tokenId: z
        .string()
        .trim()
        .regex(
            /^[^\s@!]+@[^\s@!]+![^\s@!]+$/,
            "Erwartet wird `benutzer@realm!tokenname`.",
        ),
    tokenSecret: z.string().trim().min(8),
});

type Ctx = ModuleContext<ProxmoxConfig, ProxmoxServerConfig>;

function clientFor(ctx: Ctx): ProxmoxClient {
    const parsed = proxmoxCredentialsSchema.safeParse(ctx.server.credentials);

    if (!parsed.success) {
        throw new ProvisioningInputError(
            "Der API-Token des Servers ist unvollständig. " +
                "Bitte in den Einstellungen hinterlegen.",
        );
    }

    return proxmoxClient({
        baseUrl: ctx.server.config.apiUrl,
        credentials: parsed.data,
        fetchImpl: ctx.fetchImpl,
        sleepImpl: ctx.sleepImpl,
    });
}

/** The VMID this service's machine has, or null before one is reserved. */
function vmidOf(ctx: Ctx): string | null {
    return ctx.resource?.externalId ?? null;
}

function nodeOf(ctx: Ctx): string {
    const node = ctx.resource?.node;

    if (!node) {
        throw new ProvisioningInputError(
            "Für diese Leistung ist kein Knoten hinterlegt.",
        );
    }

    return node;
}

/**
 * The customer's SSH keys.
 *
 * `service.module_data.sshKeys` is where they live — the client service page
 * writes them there — and a task may carry a fresh set for the one call.
 * Either way they go through `parseSshKeys`, which refuses a private key and
 * refuses anything that is not a public key rather than stripping it: a
 * value trimmed into shape is a value the customer cannot tell is wrong.
 */
function sshKeysOf(ctx: Ctx): string[] {
    const fromPayload = ctx.payload.sshKeys;
    const fromService = (ctx.service.moduleData as Record<string, unknown>)
        ?.sshKeys;
    const raw = fromPayload ?? fromService ?? "";

    return parseSshKeys(Array.isArray(raw) ? raw.join("\n") : String(raw));
}

function specsOf(config: ProxmoxConfig) {
    return {
        cores: assertUnits(config.cores, "Kerne", { min: 1, max: 128 }),
        memoryMiB: assertUnits(config.memoryMiB, "Arbeitsspeicher", {
            min: 128,
            max: 1_048_576,
        }),
        diskGiB: assertUnits(config.diskGiB, "Datenträger", {
            min: 1,
            max: 32_768,
        }),
    };
}

export function buildHostname(
    pattern: string,
    input: { label: string; vmid: string },
): string {
    const raw = pattern
        .replaceAll("{label}", input.label)
        .replaceAll("{id}", input.vmid)
        .replaceAll("{rand}", hostSuffix());

    return toHostname(raw, `vm-${input.vmid}`);
}

/** The cloud-init and hardware parameters, ready for `URLSearchParams`. */
export function configParams(input: {
    config: ProxmoxConfig;
    server: ProxmoxServerConfig;
    hostname: string;
    password: string | null;
    sshKeys: string[];
    addresses: Ctx["addresses"];
}): Record<string, string | number | undefined> {
    const specs = specsOf(input.config);

    /**
     * **`ipconfig0` carries one address per family, because that is what it
     * is.** It belongs to `net0` and its grammar is one `ip=` and one
     * `ip6=`; a second of either is a duplicate key, which PVE refuses with
     * `parameter verification failed`. Built from every assigned address,
     * a product ordering two IPv4s therefore could not be provisioned at
     * all — the create failed on every attempt and the second address was
     * held by a machine that was never made.
     *
     * The further addresses are still the customer's and still assigned to
     * the service; they are routed to the machine's first address and
     * configured inside the guest. `create` says so on the task.
     */
    const entries: IpConfigInput[] = (["ipv4", "ipv6"] as const)
        .map((family) =>
            input.addresses.find((address) => address.family === family),
        )
        .filter((address) => address !== undefined)
        .map((address) => ({
            family: address.family,
            address: address.address,
            prefixLength: address.prefixLength,
            gateway: address.gateway,
        }));

    const nameservers = nameserverValue(
        input.addresses.flatMap((address) => address.nameservers),
    );

    const net0 =
        `virtio,bridge=${input.server.bridge}` +
        (input.server.vlanTag ? `,tag=${input.server.vlanTag}` : "");

    return {
        name: input.hostname,
        cores: specs.cores,
        memory: specs.memoryMiB,
        onboot: input.config.onboot ? 1 : 0,
        net0,
        ciuser: input.config.osUser,
        ...(input.password ? { cipassword: input.password } : {}),
        ...(input.sshKeys.length > 0
            ? {
                  /**
                   * Proxmox wants `sshkeys` URL-encoded *inside* the
                   * form-encoded body — it decodes the parameter once itself
                   * and then expects to find an already-encoded blob. Left
                   * un-encoded, every key after the first is lost at the
                   * newline.
                   */
                  sshkeys: encodeURIComponent(input.sshKeys.join("\n")),
              }
            : {}),
        ...(entries.length > 0 ? { ipconfig0: ipConfigValue(entries) } : {}),
        ...(nameservers ? { nameserver: nameservers } : {}),
        ...(input.server.searchDomain
            ? { searchdomain: input.server.searchDomain }
            : {}),
    };
}

/** PVE's own words for "it is already as you want it". */
function alreadyThere(error: unknown): boolean {
    return error instanceof ProxmoxError && error.alreadyExists;
}

function gone(error: unknown): boolean {
    return error instanceof ProxmoxError && error.missing;
}

/**
 * A lock that means "somebody is still building this machine".
 *
 * `backup`, `migrate` and our own `suspended` all say something else, and
 * only these two say the VM is incomplete.
 */
function isBuilding(lock: string | null): boolean {
    return lock === "clone" || lock === "create";
}

type VmReading = { exists: boolean; status: string; lock: string | null };

async function readStatus(
    client: ProxmoxClient,
    node: string,
    vmid: string,
): Promise<VmReading> {
    try {
        const status = await client.status(node, vmid);

        return { exists: true, status: status.status, lock: status.lock };
    } catch (error) {
        if (gone(error)) {
            return { exists: false, status: "missing", lock: null };
        }

        throw error;
    }
}

/**
 * Where a VM actually is, before tearing it down.
 *
 * **"Not on the node we remember" is not "gone".** The node is recorded once
 * at create and kept for ever, because a retry has to look for the machine
 * where it was put — but an operator who migrates a VM in the Proxmox UI
 * moves it, and from then on the old node answers `does not exist`.
 * `terminate` read that as "already gone", which is its documented success:
 * the service was booked as torn down and the customer's addresses went back
 * into the pool, while the machine kept running and answering on one of
 * them. The next customer would have been handed the same address.
 *
 * So a terminate that cannot find the machine asks the cluster before it
 * believes it. One call, only on the path that would otherwise release
 * somebody's addresses.
 */
async function locate(
    client: ProxmoxClient,
    node: string,
    vmid: string,
): Promise<{ node: string; status: VmReading } | null> {
    const here = await readStatus(client, node, vmid);

    if (here.exists) {
        return { node, status: here };
    }

    const elsewhere = await client.findVm(vmid);

    if (!elsewhere || elsewhere === node) {
        return null;
    }

    const there = await readStatus(client, elsewhere, vmid);

    return there.exists ? { node: elsewhere, status: there } : null;
}

async function create(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const config = ctx.config;
    const server = ctx.server.config;
    const specs = specsOf(config);
    const warnings: string[] = [];

    /**
     * The addresses first, and before anything at the provider: a create
     * that cannot be given an address must fail while nothing exists, so the
     * abort path can give back what it took (see `runner.ts`). Topping up to
     * `count` rather than adding `count` is what keeps a retried create from
     * walking the pool down one address per attempt.
     */
    const addresses = [
        ...(await ctx.allocateAddresses({
            family: "ipv4",
            count: config.ipv4Count,
            poolId: config.ipv4PoolId,
        })),
        ...(await ctx.allocateAddresses({
            family: "ipv6",
            count: config.ipv6Count,
            poolId: config.ipv6PoolId,
        })),
    ];

    const templateNode = config.templateNode ?? server.templateNode;
    const templateVmid = config.templateVmid ?? server.templateVmid;

    /**
     * Where it goes. Only decided once: a retry uses the node already on the
     * reserved resource, because the machine — if the first attempt got that
     * far — is on that node and nowhere else.
     */
    let node = ctx.resource?.node ?? null;

    if (!node) {
        const nodes: NodeCapacity[] = await client.nodes();

        node = selectNode(
            nodes,
            { memoryMiB: specs.memoryMiB, cores: specs.cores },
            { allow: server.nodes, deny: server.excludeNodes },
        ).node;
    }

    const resource = await ctx.reserveResource({
        kind: "qemu",
        nextId: () => client.nextId(),
        node,
    });

    const vmid = resource.externalId;
    const placedOn = resource.node ?? node;

    const hostname = buildHostname(config.hostnamePattern, {
        label: ctx.service.label,
        vmid,
    });

    /**
     * Everything from here on can change the cluster. Past this line a
     * failure keeps the VMID and the addresses, because the machine may
     * exist on the other side of a timeout.
     */
    await ctx.markProviderCalled();

    const existing = await readStatus(client, placedOn, vmid);
    let cloned = false;

    /**
     * **A VM that exists is not necessarily a VM that is finished.**
     *
     * PVE writes the target's configuration at the *start* of a clone and
     * holds `lock: "clone"` on it until the copy is done, so a create
     * retried while the first clone is still running finds the machine,
     * concludes "already there", and issues `setConfig` against it — which
     * PVE refuses with `500 VM 101 is locked (clone)`. That is not in the
     * retryable set, so it counted as permanent: any clone slower than the
     * task deadline ended with the VMID held, the addresses held, cloud-init
     * never applied and the machine never started, on a paid invoice.
     *
     * Waiting is the right answer and it is already built — a retryable
     * error puts the task back on the queue with a backoff, and the next
     * attempt asks the same question again.
     */
    if (existing.exists && isBuilding(existing.lock)) {
        throw new ProxmoxError(
            503,
            `VM ${vmid} wird gerade angelegt (lock: ${existing.lock}) — später erneut`,
            "",
        );
    }

    if (!existing.exists) {
        try {
            await client.clone({
                node: templateNode,
                templateVmid,
                newId: vmid,
                name: hostname,
                targetNode: placedOn === templateNode ? null : placedOn,
                storage: config.storage ?? server.storage,
                pool: server.pool,
                description: `virtify ${ctx.service.id}`,
            });
            cloned = true;
        } catch (error) {
            if (!alreadyThere(error)) {
                throw error;
            }

            /**
             * The previous attempt's clone did go through after all — the
             * answer arrived after we had stopped listening. This is the
             * case the reserved VMID exists for, and it is a success.
             */
            ctx.log(`VM ${vmid} war bereits vorhanden.`);
        }
    }

    await ctx.confirmResource(placedOn);

    const existingCredentials = await ctx.readCredentials();
    /**
     * A retry does not mint a second password. The customer may already
     * have the first one — the page shows it the moment the row is written
     * — and cloud-init only applies what it is given at first boot anyway,
     * so a second password would be one the machine does not have.
     */
    const password = existingCredentials?.password ?? generatePassword();
    const sshKeys = sshKeysOf(ctx);

    await client.setConfig(placedOn, vmid, {
        ...configParams({
            config,
            server,
            hostname,
            password,
            sshKeys,
            addresses,
        }),
    });

    /**
     * The disk. A clone comes out at the template's size, so this is a grow
     * to the ordered size — and Proxmox takes a `+NG` delta, not a target,
     * which is why the template's own size has to be read rather than
     * assumed. A template already at or past the ordered size is left alone
     * rather than shrunk: Proxmox cannot shrink a disk at all and pretending
     * otherwise would make every create of a small package fail.
     */
    const current = await client.status(placedOn, vmid);
    const wantedBytes = specs.diskGiB * 1024 ** 3;

    if (current.maxdisk !== null && current.maxdisk < wantedBytes) {
        const grow = Math.ceil((wantedBytes - current.maxdisk) / 1024 ** 3);

        await client.resizeDisk(placedOn, vmid, server.diskBus, `+${grow}G`);
    } else if (current.maxdisk !== null && current.maxdisk > wantedBytes) {
        warnings.push(
            `Die Vorlage bringt ${Math.round(current.maxdisk / 1024 ** 3)} GB mit, ` +
                `bestellt sind ${specs.diskGiB} GB. Proxmox kann einen Datenträger ` +
                "nicht verkleinern — die Leistung läuft mit dem größeren.",
        );
    }

    if (config.nesting) {
        try {
            await client.setConfig(placedOn, vmid, { cpu: "host" });
        } catch (error) {
            warnings.push(
                `Nested Virtualisierung konnte nicht gesetzt werden: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    await ctx.setCredentials({
        username: config.osUser,
        password,
        host: addresses[0]?.address ?? "",
    });

    const extra =
        addresses.length - new Set(addresses.map((a) => a.family)).size;

    if (extra > 0) {
        warnings.push(
            `${extra} weitere Adresse(n) sind der Leistung zugewiesen, aber nicht ` +
                "in cloud-init eingetragen: `ipconfig0` trägt je Familie genau eine. " +
                "Sie sind auf die erste Adresse geroutet und werden im Gast konfiguriert.",
        );
    }

    await ctx.patchModuleData({
        vmid,
        node: placedOn,
        hostname,
        cores: specs.cores,
        memoryMiB: specs.memoryMiB,
        diskGiB: specs.diskGiB,
    });

    if (current.status !== "running") {
        await client.power(placedOn, vmid, "start");
    }

    return {
        summary: cloned
            ? `VM ${vmid} auf ${placedOn} angelegt und gestartet.`
            : `VM ${vmid} auf ${placedOn} war bereits vorhanden und ist eingerichtet.`,
        alreadyDone: !cloned,
        data: { vmid, node: placedOn, hostname },
        warnings,
    };
}

async function suspend(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        return {
            summary: "Es gibt keine VM, die gesperrt werden könnte.",
            alreadyDone: true,
        };
    }

    const node = nodeOf(ctx);
    const warnings: string[] = [];

    await ctx.markProviderCalled();

    const current = await readStatus(client, node, vmid);

    if (!current.exists) {
        return {
            summary: `VM ${vmid} existiert nicht (mehr) — nichts zu sperren.`,
            alreadyDone: true,
        };
    }

    /**
     * `onboot=0` first, and it is the part that matters: without it the next
     * host reboot brings a suspended customer's machine straight back. It
     * needs no privilege, unlike the lock below.
     */
    await client.setConfig(node, vmid, { onboot: 0 });

    let stopped = false;

    if (current.status === "running") {
        await client.power(node, vmid, "stop");
        stopped = true;
    }

    if (ctx.server.config.lockOnSuspend) {
        try {
            await client.setConfig(node, vmid, { lock: "suspended" });
        } catch (error) {
            /**
             * Expected on any sensible installation: setting `lock` is
             * `root@pam` only and our own setup guide asks for a restricted
             * token. The stop is the suspension; this is a second belt, and
             * a belt that cannot be fastened is a note, not a failure.
             */
            warnings.push(
                error instanceof ProxmoxError && error.forbidden
                    ? "Der API-Token darf `lock` nicht setzen (nur root@pam). " +
                          "Die VM ist gestoppt und startet nicht mehr mit dem Host."
                    : `Sperre konnte nicht gesetzt werden: ${
                          error instanceof Error ? error.message : String(error)
                      }`,
            );
        }
    }

    return {
        summary: stopped
            ? `VM ${vmid} gestoppt und vom Hoststart abgemeldet.`
            : `VM ${vmid} lief bereits nicht; vom Hoststart abgemeldet.`,
        alreadyDone: !stopped,
        warnings,
    };
}

async function unsuspend(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        return {
            summary: "Es gibt keine VM, die entsperrt werden könnte.",
            alreadyDone: true,
        };
    }

    const node = nodeOf(ctx);
    const warnings: string[] = [];

    await ctx.markProviderCalled();

    const current = await readStatus(client, node, vmid);

    if (!current.exists) {
        return {
            summary: `VM ${vmid} existiert nicht (mehr) — nichts zu entsperren.`,
            alreadyDone: true,
        };
    }

    if (current.lock) {
        try {
            // An empty `lock` clears it; same privilege as setting one.
            await client.setConfig(node, vmid, { lock: "" });
        } catch (error) {
            warnings.push(
                `Die Sperre konnte nicht aufgehoben werden: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    await client.setConfig(node, vmid, {
        onboot: ctx.config.onboot ? 1 : 0,
    });

    if (current.status !== "running") {
        await client.power(node, vmid, "start");

        return {
            summary: `VM ${vmid} entsperrt und gestartet.`,
            warnings,
        };
    }

    return {
        summary: `VM ${vmid} läuft bereits.`,
        alreadyDone: true,
        warnings,
    };
}

async function terminate(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        /**
         * Nothing was ever made — an order terminated before its create ran.
         * Still a success, and the runner still gives the addresses back,
         * because the service is over either way.
         */
        return {
            summary: "Es gab keine VM. Nichts abzubauen.",
            alreadyDone: true,
        };
    }

    const node = nodeOf(ctx);

    await ctx.markProviderCalled();

    try {
        const found = await locate(client, node, vmid);

        if (!found) {
            return {
                summary: `VM ${vmid} existiert nirgends im Cluster mehr.`,
                alreadyDone: true,
            };
        }

        const current = found.status;

        if (found.node !== node) {
            ctx.log(
                `VM ${vmid} liegt inzwischen auf ${found.node}, nicht auf ${node}.`,
            );
        }

        if (current.lock) {
            await client
                .setConfig(found.node, vmid, { lock: "" })
                .catch(() => undefined);
        }

        if (current.status === "running") {
            await client.power(found.node, vmid, "stop");
        }

        await client.destroy(found.node, vmid, { purge: true });
    } catch (error) {
        /**
         * A VM that is not there is a VM that does not need destroying. This
         * is the "already done is a success" of the teardown path, and it
         * has to hold: without it a retried terminate fails for ever, the
         * addresses are never released, and a pool bleeds one address per
         * cancelled customer.
         */
        if (!gone(error)) {
            throw error;
        }

        return {
            summary: `VM ${vmid} war schon weg.`,
            alreadyDone: true,
        };
    }

    return { summary: `VM ${vmid} abgebaut.`, data: { vmid, node } };
}

async function changePackage(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        return {
            summary:
                "Es gibt noch keine VM — der Tarif gilt, sobald sie angelegt wird.",
            alreadyDone: true,
        };
    }

    const node = nodeOf(ctx);
    const specs = specsOf(ctx.config);
    const warnings: string[] = [];

    await ctx.markProviderCalled();

    const current = await readStatus(client, node, vmid);

    if (!current.exists) {
        return {
            summary: `VM ${vmid} existiert nicht (mehr).`,
            alreadyDone: true,
        };
    }

    await client.setConfig(node, vmid, {
        cores: specs.cores,
        memory: specs.memoryMiB,
    });

    const status = await client.status(node, vmid);
    const wantedBytes = specs.diskGiB * 1024 ** 3;

    if (status.maxdisk !== null && status.maxdisk < wantedBytes) {
        const grow = Math.ceil((wantedBytes - status.maxdisk) / 1024 ** 3);

        await client.resizeDisk(
            node,
            vmid,
            ctx.server.config.diskBus,
            `+${grow}G`,
        );
    } else if (status.maxdisk !== null && status.maxdisk > wantedBytes) {
        /**
         * The downgrade that cannot be carried out. Proxmox cannot shrink a
         * disk and a panel that quietly pretended it had would leave a
         * customer on 200 GB while they pay for 50. It is said out loud, on
         * the task and in the admin area, and the billing side is already
         * correct — the proration was calculated from the price, not from
         * the disk.
         */
        warnings.push(
            `Der Datenträger bleibt bei ${Math.round(
                status.maxdisk / 1024 ** 3,
            )} GB. Proxmox kann ihn nicht verkleinern; das muss von Hand ` +
                "über eine Neuinstallation geschehen.",
        );
    }

    if (status.status === "running") {
        warnings.push(
            "Kerne und Arbeitsspeicher werden mit dem nächsten Neustart der VM wirksam.",
        );
    }

    await ctx.patchModuleData({
        cores: specs.cores,
        memoryMiB: specs.memoryMiB,
        diskGiB: specs.diskGiB,
    });

    return {
        summary: `VM ${vmid} auf ${specs.cores} Kerne / ${specs.memoryMiB} MiB gesetzt.`,
        warnings,
    };
}

const POWER_ACTIONS = ["start", "stop", "shutdown", "reboot"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

export function isPowerAction(value: unknown): value is PowerAction {
    return (
        typeof value === "string" &&
        (POWER_ACTIONS as readonly string[]).includes(value)
    );
}

async function power(ctx: Ctx): Promise<ModuleResult> {
    const which = ctx.payload.power;

    if (!isPowerAction(which)) {
        throw new ProvisioningInputError(
            `„${String(which)}“ ist keine Aktion. Erlaubt sind ${POWER_ACTIONS.join(", ")}.`,
        );
    }

    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        throw new ProvisioningInputError(
            "Für diese Leistung gibt es noch keine VM.",
        );
    }

    const node = nodeOf(ctx);

    await ctx.markProviderCalled();

    const current = await readStatus(client, node, vmid);

    if (!current.exists) {
        throw new ProxmoxError(404, `VM ${vmid} does not exist`, "");
    }

    /**
     * Already so. Proxmox itself is content to start a running VM, but
     * saying "läuft bereits" is more useful than "gestartet" to a customer
     * who pressed the button because the machine seemed dead.
     */
    if (which === "start" && current.status === "running") {
        return { summary: `VM ${vmid} läuft bereits.`, alreadyDone: true };
    }

    if (
        (which === "stop" || which === "shutdown") &&
        current.status === "stopped"
    ) {
        return { summary: `VM ${vmid} ist bereits aus.`, alreadyDone: true };
    }

    await client.power(node, vmid, which);

    const label: Record<PowerAction, string> = {
        start: "gestartet",
        stop: "hart ausgeschaltet",
        shutdown: "zum Herunterfahren aufgefordert",
        reboot: "neu gestartet",
    };

    return { summary: `VM ${vmid} ${label[which]}.` };
}

async function reinstall(ctx: Ctx): Promise<ModuleResult> {
    const client = clientFor(ctx);
    const vmid = vmidOf(ctx);

    if (!vmid) {
        throw new ProvisioningInputError(
            "Für diese Leistung gibt es noch keine VM.",
        );
    }

    const node = nodeOf(ctx);
    const config = ctx.config;
    const server = ctx.server.config;
    const specs = specsOf(config);
    const templateNode = config.templateNode ?? server.templateNode;
    const templateVmid = config.templateVmid ?? server.templateVmid;

    await ctx.markProviderCalled();

    /**
     * Destroy and clone again **under the same VMID, with the same
     * addresses**. That is the whole payoff of reserving the id: a
     * reinstall is a terminate and a create that cannot lose the identity
     * in between, so the customer's IP, their rDNS and every ticket that
     * names the machine still point at it afterwards.
     */
    const current = await readStatus(client, node, vmid);

    if (current.exists) {
        if (current.lock) {
            await client
                .setConfig(node, vmid, { lock: "" })
                .catch(() => undefined);
        }

        if (current.status === "running") {
            await client.power(node, vmid, "stop");
        }

        await client.destroy(node, vmid, { purge: true });
    }

    const hostname = buildHostname(config.hostnamePattern, {
        label: ctx.service.label,
        vmid,
    });
    const password = generatePassword();
    const sshKeys = sshKeysOf(ctx);

    await client.clone({
        node: templateNode,
        templateVmid,
        newId: vmid,
        name: hostname,
        targetNode: node === templateNode ? null : node,
        storage: config.storage ?? server.storage,
        pool: server.pool,
        description: `virtify ${ctx.service.id}`,
    });

    await client.setConfig(
        node,
        vmid,
        configParams({
            config,
            server,
            hostname,
            password,
            sshKeys,
            addresses: ctx.addresses,
        }),
    );

    const fresh = await client.status(node, vmid);
    const wantedBytes = specs.diskGiB * 1024 ** 3;

    if (fresh.maxdisk !== null && fresh.maxdisk < wantedBytes) {
        const grow = Math.ceil((wantedBytes - fresh.maxdisk) / 1024 ** 3);

        await client.resizeDisk(node, vmid, server.diskBus, `+${grow}G`);
    }

    await ctx.setCredentials({
        username: config.osUser,
        password,
        host: ctx.addresses[0]?.address ?? "",
    });

    await client.power(node, vmid, "start");

    return {
        summary: `VM ${vmid} neu installiert. Das Passwort ist neu.`,
        data: { vmid, node, hostname },
    };
}

async function getStatus(ctx: Ctx): Promise<ProviderStatus> {
    const vmid = vmidOf(ctx);

    if (!vmid) {
        return { state: "unknown", detail: "Noch keine VM angelegt." };
    }

    const client = clientFor(ctx);
    const node = nodeOf(ctx);

    try {
        const status = await client.status(node, vmid);

        if (status.lock) {
            return {
                state: "suspended",
                detail: `Gesperrt (${status.lock}).`,
                data: { lock: status.lock },
            };
        }

        return {
            state: status.status === "running" ? "running" : "stopped",
            detail:
                status.status === "running"
                    ? `Läuft seit ${Math.floor(status.uptime / 3600)} h.`
                    : "Ausgeschaltet.",
            data: {
                uptime: status.uptime,
                cpus: status.cpus,
                maxmem: status.maxmem,
            },
        };
    } catch (error) {
        if (gone(error)) {
            return {
                state: "unknown",
                detail: `VM ${vmid} existiert auf dem Cluster nicht (mehr).`,
                missing: true,
            };
        }

        if (error instanceof ProxmoxUnreachableError) {
            return {
                state: "unknown",
                detail: "Der Cluster war nicht erreichbar.",
            };
        }

        throw error;
    }
}

async function console_(input: {
    server: {
        config: ProxmoxServerConfig;
        credentials: Record<string, string>;
    };
    resource: { externalId: string; node: string | null };
    now: Date;
    fetchImpl?: typeof fetch;
}): Promise<ConsoleTicket | null> {
    const credentials = proxmoxCredentialsSchema.safeParse(
        input.server.credentials,
    );

    if (!credentials.success || !input.resource.node) {
        return null;
    }

    const client = proxmoxClient({
        baseUrl: input.server.config.apiUrl,
        credentials: credentials.data,
        fetchImpl: input.fetchImpl,
    });

    const vmid = input.resource.externalId;
    const node = input.resource.node;
    const proxy = await client.vncProxy(node, vmid);
    const base = input.server.config.apiUrl.replace(/\/+$/, "");

    return {
        websocketUrl:
            `${base.replace(/^https:/, "wss:")}/api2/json/nodes/` +
            `${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}` +
            `/vncwebsocket?port=${encodeURIComponent(proxy.port)}` +
            `&vncticket=${encodeURIComponent(proxy.ticket)}`,
        ticket: proxy.ticket,
        port: proxy.port,
        /** PVE's VNC tickets are good for two minutes. */
        expiresAt: new Date(input.now.getTime() + 120_000),
        providerUrl:
            `${base}/?console=kvm&novnc=1&node=${encodeURIComponent(node)}` +
            `&resize=off&vmid=${encodeURIComponent(vmid)}`,
    };
}

async function testConnection(input: {
    config: ProxmoxServerConfig;
    credentials: Record<string, string>;
    fetchImpl?: typeof fetch;
}): Promise<ConnectionCheck> {
    const credentials = proxmoxCredentialsSchema.safeParse(input.credentials);

    if (!credentials.success) {
        return {
            ok: false,
            detail: "Es ist kein vollständiger API-Token hinterlegt.",
        };
    }

    const client = proxmoxClient({
        baseUrl: input.config.apiUrl,
        credentials: credentials.data,
        fetchImpl: input.fetchImpl,
    });

    try {
        const version = await client.version();
        const nodes = await client.nodes();
        const online = nodes.filter((node) => node.status === "online");

        /**
         * The template is checked too, because "the token works" is not the
         * question the operator is asking — "will an order go through" is,
         * and a missing template is the way it most often does not.
         */
        let template = "";

        try {
            await client.status(
                input.config.templateNode,
                input.config.templateVmid,
            );
            template = `Vorlage ${input.config.templateVmid} auf ${input.config.templateNode} gefunden.`;
        } catch (error) {
            template = gone(error)
                ? `Achtung: Vorlage ${input.config.templateVmid} auf ` +
                  `${input.config.templateNode} gibt es nicht.`
                : `Vorlage konnte nicht geprüft werden: ${
                      error instanceof Error ? error.message : String(error)
                  }`;
        }

        return {
            ok: true,
            detail:
                `Proxmox VE ${version?.version ?? "?"}, ${online.length} von ` +
                `${nodes.length} Knoten online. ${template}`,
        };
    } catch (error) {
        if (error instanceof ProxmoxError && error.forbidden) {
            return {
                ok: false,
                detail:
                    "Der Token wurde abgelehnt. Stimmen Token-ID, Secret und " +
                    "die Rechte des Benutzers im Cluster?",
            };
        }

        return {
            ok: false,
            detail:
                error instanceof Error
                    ? error.message
                    : "Unbekannter Fehler beim Verbindungstest.",
        };
    }
}

export const proxmoxModule: ProvisioningModule<
    ProxmoxConfig,
    ProxmoxServerConfig
> = {
    id: MODULE_ID,
    label: "Proxmox VE",
    description:
        "Legt je bestellter Einheit eine virtuelle Maschine an: Klon aus einer " +
        "Vorlage, Kerne/RAM/Datenträger aus den Produkteinstellungen, " +
        "cloud-init für Hostname, Zugang und IP-Adressen. Sperren heißt " +
        "stoppen und vom Hoststart abmelden.",
    configSchema: proxmoxConfigSchema,
    serverSchema: proxmoxServerSchema,
    provisions: true,
    clientActions: [
        { id: "start", label: "Starten", description: "Schaltet die VM ein." },
        {
            id: "shutdown",
            label: "Herunterfahren",
            description: "Bittet das Gastsystem, sich zu beenden.",
        },
        {
            id: "reboot",
            label: "Neu starten",
            description: "Fährt das Gastsystem herunter und startet es wieder.",
        },
        {
            id: "stop",
            label: "Hart ausschalten",
            description:
                "Zieht der VM den Strom. Laufende Schreibvorgänge gehen verloren.",
            destructive: true,
        },
        {
            id: "reinstall",
            label: "Neu installieren",
            description:
                "Baut die VM aus der Vorlage neu auf. Alle Daten gehen " +
                "verloren; IP-Adressen und Hostname bleiben.",
            destructive: true,
        },
    ],
    create,
    suspend,
    unsuspend,
    terminate,
    changePackage,
    power,
    reinstall,
    getStatus,
    console: console_,
    testConnection,
};
