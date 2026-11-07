"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import {
    CatalogError,
    createCoupon,
    deleteCoupon,
    updateCoupon,
} from "@/server/catalog/repository";
import { couponInputSchema } from "@/server/catalog/schema";
import type { CatalogState } from "../actions";
import { cents, date, flag, integer, optional, text } from "../form";

export type { CatalogState };

async function actor() {
    const session = await requirePermission("catalog.write");

    return {
        actor: {
            type: "staff" as const,
            id: session.user.id,
            label: session.user.email,
        },
        origin: await requestOrigin(),
    };
}

/**
 * A percentage is typed as a percentage — "15" or "12,5" — and stored as
 * basis points, so the rate itself is an integer and cannot pick up a
 * rounding error of its own on the way to a price.
 */
function basisPoints(data: FormData): number | null {
    const raw = text(data, "percent").replace(",", ".");

    if (raw === "") {
        return null;
    }

    const value = Number.parseFloat(raw);

    return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** Every non-empty string the form sent under `name`. */
function strings(data: FormData, name: string): string[] {
    return data
        .getAll(name)
        .filter(
            (value): value is string =>
                typeof value === "string" && value !== "",
        );
}

function read(data: FormData) {
    const kind = optional(data, "kind") === "fixed" ? "fixed" : "percent";

    return {
        code: text(data, "code"),
        description: optional(data, "description") ?? "",
        kind,
        percentBasisPoints: kind === "percent" ? basisPoints(data) : null,
        amountCents: kind === "fixed" ? cents(data, "amount") : null,
        currency:
            kind === "fixed" ? (optional(data, "currency") ?? "EUR") : null,
        duration: optional(data, "duration") ?? "once",
        durationPeriods:
            optional(data, "duration") === "repeating"
                ? integer(data, "durationPeriods", 0) || null
                : null,
        appliesToSetupFee: flag(data, "appliesToSetupFee"),
        // `knownProductIds` is every product the form rendered a checkbox
        // for. A restriction to a product the form could not show — one past
        // the hundredth, or one that has since been deleted — is kept rather
        // than dropped: an empty `productIds` means "every product", so
        // losing one silently turns a product-specific coupon into a
        // catalog-wide one.
        productIds: [
            ...new Set([
                ...strings(data, "productIds"),
                ...strings(data, "existingProductIds").filter(
                    (id) => !strings(data, "knownProductIds").includes(id),
                ),
            ]),
        ],
        cycles: strings(data, "cycles"),
        validFrom: date(data, "validFrom"),
        // Through the end of that day, not from its first second. See form.ts.
        validUntil: date(data, "validUntil", true),
        maxRedemptions: integer(data, "maxRedemptions", 0) || null,
        active: flag(data, "active"),
    };
}

function failed(message: string): CatalogState {
    return { status: "error", message };
}

export async function addCoupon(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const parsed = couponInputSchema.safeParse(read(data));

    if (!parsed.success) {
        return failed(
            parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        );
    }

    try {
        await createCoupon(db, parsed.data, who, origin);
    } catch (error) {
        if (!(error instanceof CatalogError)) {
            throw error;
        }

        return failed(error.message);
    }

    revalidatePath("/admin/catalog/coupons");

    return { status: "saved" };
}

export async function saveCoupon(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const parsed = couponInputSchema.safeParse(read(data));

    if (!parsed.success) {
        return failed(
            parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        );
    }

    try {
        const row = await updateCoupon(
            db,
            text(data, "couponId"),
            parsed.data,
            who,
            origin,
        );

        if (!row) {
            return failed("Diesen Gutschein gibt es nicht.");
        }
    } catch (error) {
        if (!(error instanceof CatalogError)) {
            throw error;
        }

        return failed(error.message);
    }

    revalidatePath("/admin/catalog/coupons");

    return { status: "saved" };
}

export async function removeCoupon(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();

    try {
        const row = await deleteCoupon(db, text(data, "couponId"), who, origin);

        if (!row) {
            return failed("Diesen Gutschein gibt es nicht.");
        }
    } catch (error) {
        if (!(error instanceof CatalogError)) {
            throw error;
        }

        return failed(error.message);
    }

    revalidatePath("/admin/catalog/coupons");

    return { status: "saved" };
}
