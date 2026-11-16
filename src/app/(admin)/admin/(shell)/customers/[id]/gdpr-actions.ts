"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { type Actor, audit } from "@/server/audit";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import {
    AnonymizationRefused,
    anonymizeCustomer,
    exportCustomerData,
} from "@/server/customers/gdpr";
import { getCustomer } from "@/server/customers/repository";

/**
 * The operator's half of the DSGVO work.
 *
 * `dsgvo.export` and `dsgvo.anonymize` are their own permission domain rather
 * than `customers.*`, because the wildcard form is documented as the thing
 * that keeps a role working across phases — and a role granted "alles rund um
 * Kunden" last year must not silently gain the power to erase an account this
 * year. An irreversible action asks to be granted on purpose.
 */

export type GdprState = {
    status: "idle" | "ok" | "error";
    message?: string;
};

const idSchema = z.object({ customerId: z.string().min(1) });

const anonymizeSchema = idSchema.extend({
    /**
     * The customer number, typed out. Not a checkbox: anonymisation cannot be
     * undone, it rewrites a real person's record, and the operator should have
     * to look at *which* account they are about to do it to.
     */
    confirm: z.string().trim().min(1),
    reason: z.string().trim().max(500).optional(),
});

/**
 * Produces the archive and records that it was produced.
 *
 * It does **not** hand the bytes back through a server action: a few megabytes
 * of base64 through the action's response is the wrong shape, and the archive
 * is a download. The action exists so the export is *audited under the
 * operator's name* and so the page can say what was in it; the file itself
 * comes from the route beside it.
 */
export async function auditedExport(
    _previous: GdprState,
    data: FormData,
): Promise<GdprState> {
    const session = await requirePermission("dsgvo.export");
    const parsed = idSchema.safeParse({ customerId: data.get("customerId") });

    if (!parsed.success) {
        return { status: "error", message: "Ungültige Anfrage." };
    }

    const customer = await getCustomer(db, parsed.data.customerId);

    if (!customer) {
        // 404 in spirit: the same answer whether it is gone or never existed.
        return { status: "error", message: "Dieses Konto gibt es nicht." };
    }

    const result = await exportCustomerData(db, customer.id);
    const origin = await requestOrigin();

    await audit(db, {
        actor: {
            type: "staff",
            id: session.user.id,
            label: session.user.email,
        } satisfies Actor,
        action: "customer.export",
        entityType: "customer",
        entityId: customer.id,
        after: {
            bytes: result.bytes.length,
            documents: result.summary.documents,
            missingDocuments: result.summary.missingDocuments,
            tables: result.summary.tables,
        },
        ip: origin.ip,
        userAgent: origin.userAgent,
    });

    revalidatePath(`/admin/customers/${customer.id}`);

    const missing =
        result.summary.missingDocuments.length > 0
            ? ` ${result.summary.missingDocuments.length} Beleg(e) fehlen im Dokumentenspeicher.`
            : "";

    return {
        status: "ok",
        message: `Auskunft erzeugt: ${Math.round(result.bytes.length / 1024)} kB, ${result.summary.documents} Beleg(e).${missing} Der Download steht unten.`,
    };
}

export async function anonymize(
    _previous: GdprState,
    data: FormData,
): Promise<GdprState> {
    const session = await requirePermission("dsgvo.anonymize");

    const parsed = anonymizeSchema.safeParse({
        customerId: data.get("customerId"),
        confirm: data.get("confirm"),
        reason: data.get("reason") ?? undefined,
    });

    if (!parsed.success) {
        return {
            status: "error",
            message: "Bitte die Kundennummer zur Bestätigung eintragen.",
        };
    }

    const customer = await getCustomer(db, parsed.data.customerId);

    if (!customer) {
        return { status: "error", message: "Dieses Konto gibt es nicht." };
    }

    if (parsed.data.confirm !== String(customer.customerNumber)) {
        return {
            status: "error",
            message: `Die Kundennummer stimmt nicht. Zur Bestätigung „${customer.customerNumber}“ eintragen.`,
        };
    }

    try {
        const result = await anonymizeCustomer(
            db,
            customer.id,
            {
                type: "staff",
                id: session.user.id,
                label: session.user.email,
            } satisfies Actor,
            { reason: parsed.data.reason ?? null },
        );

        revalidatePath(`/admin/customers/${customer.id}`);
        revalidatePath("/admin/customers");

        return {
            status: "ok",
            message: `Anonymisiert: ${result.contacts} Kontakt(e), ${result.logins} Zugang/Zugänge, ${result.tickets} Ticket(s), ${result.apiKeys} API-Schlüssel. Rechnungen und Belege bleiben für die Aufbewahrungsfrist unverändert.`,
        };
    } catch (error) {
        if (error instanceof AnonymizationRefused) {
            return { status: "error", message: error.message };
        }

        return {
            status: "error",
            message:
                error instanceof Error
                    ? error.message
                    : "Die Anonymisierung ist fehlgeschlagen.",
        };
    }
}
