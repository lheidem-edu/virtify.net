"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import {
    isServiceAction,
    requestServiceAction,
    ServiceActionError,
} from "@/server/provisioning/actions";
import { setRdns } from "@/server/provisioning/ip-pools";
import { ProvisioningInputError } from "@/server/provisioning/proxmox/sanitize";
import {
    ANY_CUSTOMER,
    revealCredentials,
} from "@/server/provisioning/repository";
import { runProvisioningPass } from "@/server/provisioning/run";
import { runProvisioningTask } from "@/server/provisioning/runner";

/**
 * What the operator may do to a service.
 *
 * `requirePermission` is the guard (rule 5) and it is asked on every action,
 * not once on the page — a server action is its own request and a page that
 * was rendered an hour ago says nothing about what the session may do now.
 *
 * Every one of these ends in the same function the API route calls. The
 * admin area is deliberately **not** allowed its own shortcut to a module:
 * two paths into a power action would be two answers to "is this service
 * active", and the one that was wrong would be the one that restarted a
 * suspended customer's machine.
 */

export type AdminServiceState = {
    status: "idle" | "done" | "error";
    message?: string;
    credentials?: Record<string, string> | null;
};

export async function runServiceAction(
    _previous: AdminServiceState,
    data: FormData,
): Promise<AdminServiceState> {
    const session = await requirePermission("services.write");
    const serviceId = String(data.get("serviceId") ?? "");
    const action = String(data.get("action") ?? "");

    if (!isServiceAction(action)) {
        return { status: "error", message: "Diese Aktion gibt es nicht." };
    }

    try {
        const result = await requestServiceAction(db, {
            serviceId,
            customer: ANY_CUSTOMER,
            action,
            asCustomer: false,
            actor: {
                type: "staff",
                id: session.user.id,
                label: session.user.name,
            },
        });

        if (!result.outcome) {
            return {
                status: "error",
                message: "Diese Leistung gibt es nicht.",
            };
        }

        if (!result.outcome.ran) {
            return {
                status: "error",
                message:
                    "Die Anfrage wird bereits bearbeitet oder hat ihre Versuche aufgebraucht.",
            };
        }

        revalidatePath("/admin/services");
        revalidatePath(`/admin/services/${serviceId}`);

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
 * „Erneut versuchen“ on a task that has given up.
 *
 * It clears the attempt count rather than enqueueing a second request: the
 * request is the row, and a second row for the same thing is how a create
 * that failed becomes two machines. What the operator is saying is "I have
 * fixed the cause", and the honest expression of that is to give this
 * request its attempts back.
 */
export async function retryTask(
    _previous: AdminServiceState,
    data: FormData,
): Promise<AdminServiceState> {
    const session = await requirePermission("services.write");
    const taskId = String(data.get("taskId") ?? "");
    const serviceId = String(data.get("serviceId") ?? "");

    const { schema } = await import("@/db");
    const { and, eq, inArray } = await import("drizzle-orm");

    const reset = await db
        .update(schema.provisioningTask)
        .set({
            status: "pending",
            attempts: 0,
            runAfter: new Date(),
            lastError: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.provisioningTask.id, taskId),
                /**
                 * Only one that is finished with. Resetting a `running` task
                 * would hand a second pass a claim the first still holds.
                 */
                inArray(schema.provisioningTask.status, ["failed", "aborted"]),
            ),
        )
        .returning({ id: schema.provisioningTask.id });

    if (reset.length === 0) {
        return {
            status: "error",
            message:
                "Diese Anfrage ist nicht in einem Zustand, in dem sie wiederholt werden kann.",
        };
    }

    const outcome = await runProvisioningTask(db, taskId, {
        actor: {
            type: "staff",
            id: session.user.id,
            label: session.user.name,
        },
    });

    revalidatePath(`/admin/services/${serviceId}`);

    return {
        status: outcome.ran && outcome.ok ? "done" : "error",
        message: outcome.ran
            ? [outcome.summary, ...outcome.warnings].join(" ")
            : "Die Anfrage konnte nicht übernommen werden.",
    };
}

/** „Jetzt ausführen“: the same pass the worker runs, in this request. */
export async function runPassNow(
    _previous: AdminServiceState,
    _data: FormData,
): Promise<AdminServiceState> {
    const session = await requirePermission("services.write");

    const result = await runProvisioningPass(db, {
        actor: {
            type: "staff",
            id: session.user.id,
            label: session.user.name,
        },
    });

    revalidatePath("/admin/services");

    return {
        status: "done",
        message:
            `${result.queued} Leistung(en) eingereiht, ${result.sweep.ran} Aufruf(e) ausgeführt, ` +
            `davon ${result.sweep.failed} fehlgeschlagen.`,
    };
}

export async function revealServiceCredentials(
    _previous: AdminServiceState,
    data: FormData,
): Promise<AdminServiceState> {
    const session = await requirePermission("services.read");
    const serviceId = String(data.get("serviceId") ?? "");

    const credentials = await revealCredentials(
        db,
        serviceId,
        ANY_CUSTOMER,
        { type: "staff", id: session.user.id, label: session.user.name },
        await requestOrigin(),
    );

    if (credentials === null) {
        return {
            status: "error",
            message: "Für diese Leistung sind keine Zugangsdaten hinterlegt.",
        };
    }

    return { status: "done", credentials };
}

export async function setAddressRdns(
    _previous: AdminServiceState,
    data: FormData,
): Promise<AdminServiceState> {
    const session = await requirePermission("services.manage");
    const addressId = String(data.get("addressId") ?? "");
    const serviceId = String(data.get("serviceId") ?? "");

    try {
        const rdns = await setRdns(
            db,
            addressId,
            String(data.get("rdns") ?? ""),
            { type: "staff", id: session.user.id, label: session.user.name },
        );

        revalidatePath(`/admin/services/${serviceId}`);

        return {
            status: "done",
            message: rdns
                ? `PTR auf ${rdns} gesetzt.`
                : "PTR-Eintrag entfernt.",
        };
    } catch (error) {
        if (error instanceof ProvisioningInputError || error instanceof Error) {
            return { status: "error", message: error.message };
        }

        throw error;
    }
}
