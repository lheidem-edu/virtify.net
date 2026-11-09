"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { getCurrentCustomer } from "@/server/customers/current";
import {
    isServiceAction,
    requestConsole,
    requestServiceAction,
    ServiceActionError,
} from "@/server/provisioning/actions";
import { ProvisioningInputError } from "@/server/provisioning/proxmox/sanitize";
import { revealCredentials } from "@/server/provisioning/repository";

/**
 * What a customer may do to their own machine.
 *
 * `getCurrentCustomer()` is the only thing that says whose rows these are
 * (rule 5), and every action is resolved **through it** — the id in the form
 * is a request, not a credential. None of these functions decides anything
 * itself: they hand the customer's own id to `requestServiceAction`, which
 * is the same function `POST /api/v1/services/{id}/actions/{action}` calls,
 * so the portal and the API cannot disagree about who may reboot what.
 */

export type ServiceActionState = {
    status: "idle" | "done" | "error";
    message?: string;
    /** Only ever set by `revealOwnCredentials`, and only for that one render. */
    credentials?: { username: string; password: string; host?: string } | null;
    console?: { url: string; expiresAt: string } | null;
};

export async function runOwnAction(
    _previous: ServiceActionState,
    data: FormData,
): Promise<ServiceActionState> {
    const serviceId = String(data.get("serviceId") ?? "");
    const action = String(data.get("action") ?? "");

    if (!isServiceAction(action)) {
        return { status: "error", message: "Diese Aktion gibt es nicht." };
    }

    const { customer } = await getCurrentCustomer();

    try {
        const result = await requestServiceAction(db, {
            serviceId,
            customer: customer.id,
            action,
            asCustomer: true,
            actor: {
                type: "customer",
                id: customer.id,
                label: customer.name,
            },
        });

        if (!result.outcome) {
            // Not this customer's service. Deliberately the same answer as a
            // service that does not exist.
            return {
                status: "error",
                message: "Diese Leistung gibt es nicht.",
            };
        }

        if (!result.outcome.ran) {
            return {
                status: "error",
                message:
                    "Diese Anfrage wird gerade bearbeitet. Einen Moment, dann erneut versuchen.",
            };
        }

        revalidatePath("/client/services");
        revalidatePath(`/client/services/${serviceId}`);

        return {
            status: result.outcome.ok ? "done" : "error",
            message: [result.outcome.summary, ...result.outcome.warnings].join(
                " ",
            ),
        };
    } catch (error) {
        if (
            error instanceof ServiceActionError ||
            error instanceof ProvisioningInputError
        ) {
            return { status: "error", message: error.message };
        }

        throw error;
    }
}

/**
 * The credential reveal.
 *
 * Audited (rule 8) — the entry names who looked and which fields were handed
 * over, never the password itself. It is the one place in the panel where
 * *reading* is the sensitive act, which is why it is a button and a server
 * action rather than a field on the page.
 */
export async function revealOwnCredentials(
    _previous: ServiceActionState,
    data: FormData,
): Promise<ServiceActionState> {
    const serviceId = String(data.get("serviceId") ?? "");
    const { customer } = await getCurrentCustomer();

    const credentials = await revealCredentials(
        db,
        serviceId,
        customer.id,
        { type: "customer", id: customer.id, label: customer.name },
        await requestOrigin(),
    );

    if (credentials === null) {
        return {
            status: "error",
            message:
                "Für diese Leistung sind keine Zugangsdaten hinterlegt — oder es gibt sie nicht.",
        };
    }

    return {
        status: "done",
        credentials: {
            username: credentials.username ?? "root",
            password: credentials.password ?? "",
            host: credentials.host,
        },
    };
}

export async function openOwnConsole(
    _previous: ServiceActionState,
    data: FormData,
): Promise<ServiceActionState> {
    const serviceId = String(data.get("serviceId") ?? "");
    const { customer } = await getCurrentCustomer();

    try {
        const ticket = await requestConsole(db, {
            serviceId,
            customer: customer.id,
            actor: { type: "customer", id: customer.id, label: customer.name },
        });

        if (!ticket) {
            return {
                status: "error",
                message: "Für diese Leistung gibt es keine Konsole.",
            };
        }

        return {
            status: "done",
            console: {
                url: ticket.websocketUrl,
                expiresAt: ticket.expiresAt.toISOString(),
            },
        };
    } catch (error) {
        if (
            error instanceof ServiceActionError ||
            error instanceof ProvisioningInputError
        ) {
            return { status: "error", message: error.message };
        }

        throw error;
    }
}
