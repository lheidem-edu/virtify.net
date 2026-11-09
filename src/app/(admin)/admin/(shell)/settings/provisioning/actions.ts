"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requirePermission } from "@/server/auth/staff-session";
import { ModuleConfigError } from "@/server/provisioning";
import {
    addAddresses,
    createPool,
    IpPoolError,
} from "@/server/provisioning/ip-pools";
import { ProvisioningInputError } from "@/server/provisioning/proxmox/sanitize";
import {
    createServer,
    deleteServer,
    ProvisioningServerError,
    testServerConnection,
    updateServer,
} from "@/server/provisioning/servers";

/**
 * The operator's hypervisors and address ranges.
 *
 * `services.manage` throughout, and asked on **every** action rather than
 * once when the page rendered: a server action is its own request, and what
 * a session could do an hour ago says nothing about what it may do now.
 *
 * The API token is write-only. An empty field leaves what is stored alone —
 * saving the form without retyping the secret must not wipe it — and there
 * is deliberately no way to read one back out: hard rule 6 keeps it
 * encrypted, and a page that could show it would be the one place it is
 * plain text.
 */

export type ProvisioningSettingsState = {
    status: "idle" | "done" | "error";
    message?: string;
};

function fail(error: unknown): ProvisioningSettingsState {
    if (
        error instanceof ProvisioningServerError ||
        error instanceof ModuleConfigError ||
        error instanceof ProvisioningInputError ||
        error instanceof IpPoolError
    ) {
        return { status: "error", message: error.message };
    }

    throw error;
}

function text(data: FormData, key: string): string {
    return String(data.get(key) ?? "").trim();
}

function list(data: FormData, key: string): string[] {
    return text(data, key)
        .split(/[\s,;]+/)
        .filter((value) => value !== "");
}

export async function saveServer(
    _previous: ProvisioningSettingsState,
    data: FormData,
): Promise<ProvisioningSettingsState> {
    const session = await requirePermission("services.manage");
    const id = text(data, "id");
    const actor = {
        type: "staff" as const,
        id: session.user.id,
        label: session.user.name,
    };

    const config = {
        apiUrl: text(data, "apiUrl"),
        templateVmid: text(data, "templateVmid"),
        templateNode: text(data, "templateNode"),
        nodes: list(data, "nodes"),
        excludeNodes: list(data, "excludeNodes"),
        storage: text(data, "storage") || null,
        bridge: text(data, "bridge") || "vmbr0",
        vlanTag: text(data, "vlanTag") ? Number(text(data, "vlanTag")) : null,
        pool: text(data, "pool") || null,
        diskBus: text(data, "diskBus") || "scsi0",
        searchDomain: text(data, "searchDomain") || null,
        lockOnSuspend: data.get("lockOnSuspend") === "on",
    };

    const tokenId = text(data, "tokenId");
    const tokenSecret = text(data, "tokenSecret");
    /**
     * Both or neither. A token id without a secret is a credential that
     * cannot work, and storing it would make the server look configured
     * while every task against it failed with a refusal.
     */
    const credentials =
        tokenId && tokenSecret ? { tokenId, tokenSecret } : undefined;

    const maxServices = text(data, "maxServices");

    try {
        if (id) {
            await updateServer(
                db,
                id,
                {
                    name: text(data, "name"),
                    hostname: text(data, "hostname") || null,
                    enabled: data.get("enabled") === "on",
                    config,
                    credentials,
                    maxServices: maxServices ? Number(maxServices) : null,
                    note: text(data, "note") || null,
                },
                actor,
            );
        } else {
            await createServer(
                db,
                {
                    module: text(data, "module") || "proxmox",
                    name: text(data, "name"),
                    hostname: text(data, "hostname") || null,
                    enabled: data.get("enabled") === "on",
                    config,
                    credentials: credentials ?? null,
                    maxServices: maxServices ? Number(maxServices) : null,
                    note: text(data, "note") || null,
                },
                actor,
            );
        }
    } catch (error) {
        return fail(error);
    }

    revalidatePath("/admin/settings/provisioning");

    return { status: "done", message: "Gespeichert." };
}

export async function testServer(
    _previous: ProvisioningSettingsState,
    data: FormData,
): Promise<ProvisioningSettingsState> {
    const session = await requirePermission("services.manage");

    try {
        const check = await testServerConnection(db, text(data, "id"), {
            type: "staff",
            id: session.user.id,
            label: session.user.name,
        });

        revalidatePath("/admin/settings/provisioning");

        return {
            status: check.ok ? "done" : "error",
            message: check.detail,
        };
    } catch (error) {
        return fail(error);
    }
}

export async function removeServer(
    _previous: ProvisioningSettingsState,
    data: FormData,
): Promise<ProvisioningSettingsState> {
    const session = await requirePermission("services.manage");

    try {
        await deleteServer(db, text(data, "id"), {
            type: "staff",
            id: session.user.id,
            label: session.user.name,
        });
    } catch (error) {
        return fail(error);
    }

    revalidatePath("/admin/settings/provisioning");

    return { status: "done", message: "Server entfernt." };
}

export async function savePool(
    _previous: ProvisioningSettingsState,
    data: FormData,
): Promise<ProvisioningSettingsState> {
    const session = await requirePermission("services.manage");
    const family = text(data, "family") === "ipv6" ? "ipv6" : "ipv4";

    try {
        await createPool(
            db,
            {
                serverId: text(data, "serverId") || null,
                name: text(data, "name"),
                family,
                cidr: text(data, "cidr") || null,
                gateway: text(data, "gateway") || null,
                prefixLength: Number(text(data, "prefixLength")),
                nameservers: list(data, "nameservers"),
                enabled: data.get("enabled") === "on",
                note: text(data, "note") || null,
            },
            { type: "staff", id: session.user.id, label: session.user.name },
        );
    } catch (error) {
        return fail(error);
    }

    revalidatePath("/admin/settings/provisioning");

    return { status: "done", message: "Pool angelegt." };
}

export async function addPoolAddresses(
    _previous: ProvisioningSettingsState,
    data: FormData,
): Promise<ProvisioningSettingsState> {
    const session = await requirePermission("services.manage");

    try {
        const result = await addAddresses(
            db,
            text(data, "poolId"),
            list(data, "addresses"),
            { type: "staff", id: session.user.id, label: session.user.name },
            { reserved: data.get("reserved") === "on" },
        );

        revalidatePath("/admin/settings/provisioning");

        return {
            status: "done",
            message:
                `${result.added} Adresse(n) aufgenommen` +
                (result.skipped > 0
                    ? `, ${result.skipped} waren schon im Pool.`
                    : "."),
        };
    } catch (error) {
        return fail(error);
    }
}
