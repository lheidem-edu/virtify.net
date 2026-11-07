import "server-only";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { type Actor, audit } from "@/server/audit";
import { isTaxStrategyId, taxStrategy } from "./index";
import type { TaxStrategy, TaxStrategyId } from "./types";

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/**
 * Which strategy is in force at a given instant.
 *
 * The answer comes from `tax_mode_history`, not from a setting: switching to
 * regular VAT is an event with a date, and an invoice finalized the day
 * before has to keep saying that no VAT was charged for as long as the books
 * are kept. The resolver therefore takes the *finalization date* and never
 * "now" — which is the whole reason this is a function and not a constant.
 */

/** What a fresh installation runs under until a row says otherwise. */
export const DEFAULT_TAX_STRATEGY: TaxStrategyId = "kleinunternehmer";

export type TaxMode = {
    strategy: TaxStrategyId;
    effectiveFrom: Date | null;
    note: string | null;
};

export async function taxModeAt(
    executor: Executor,
    at: Date,
): Promise<TaxMode> {
    const [row] = await executor
        .select()
        .from(schema.taxModeHistory)
        .where(lte(schema.taxModeHistory.effectiveFrom, at))
        .orderBy(desc(schema.taxModeHistory.effectiveFrom))
        .limit(1);

    if (!row || !isTaxStrategyId(row.strategy)) {
        // An empty table is a database the seed never touched; an unknown id
        // is a row written by a build that had a strategy this one does not.
        // Either way the § 19 default is the safe answer, because it is the
        // only one that cannot invent a tax charge.
        return {
            strategy: DEFAULT_TAX_STRATEGY,
            effectiveFrom: null,
            note: null,
        };
    }

    return {
        strategy: row.strategy,
        effectiveFrom: row.effectiveFrom,
        note: row.note,
    };
}

/** The strategy object itself, for the instant a document is finalized. */
export async function resolveTaxStrategy(
    executor: Executor,
    at: Date,
): Promise<TaxStrategy> {
    return taxStrategy((await taxModeAt(executor, at)).strategy);
}

/** The whole history, oldest first, for the admin page. */
export async function listTaxModes(executor: Executor = defaultDb) {
    return executor
        .select()
        .from(schema.taxModeHistory)
        .orderBy(asc(schema.taxModeHistory.effectiveFrom));
}

/** Switches scheduled for later — the only ones that may still be withdrawn. */
export async function listFutureTaxModes(executor: Executor, at: Date) {
    return executor
        .select()
        .from(schema.taxModeHistory)
        .where(gt(schema.taxModeHistory.effectiveFrom, at))
        .orderBy(asc(schema.taxModeHistory.effectiveFrom));
}

export class TaxModeError extends Error {
    constructor(
        readonly code:
            | "unknown-strategy"
            | "in-the-past"
            | "duplicate"
            | "not-scheduled",
        message: string,
    ) {
        super(message);
        this.name = "TaxModeError";
    }
}

/**
 * Schedules a switch. Only forwards: a switch dated into the past would
 * change the strategy of invoices that are already finalized the next time
 * anything re-read them, which is precisely what the effective date exists to
 * prevent. "Now" is allowed — that is a switch taking effect immediately.
 */
export async function scheduleTaxMode(
    db: Db,
    input: { strategy: string; effectiveFrom: Date; note?: string | null },
    actor: Actor,
    now = new Date(),
) {
    if (!isTaxStrategyId(input.strategy)) {
        throw new TaxModeError(
            "unknown-strategy",
            `Unbekannte Besteuerungsart: ${input.strategy}`,
        );
    }

    // A minute of slack, so a form submitted with today's date at 00:00 of a
    // day that has already started is not refused by a few milliseconds.
    if (input.effectiveFrom.getTime() < now.getTime() - 60_000) {
        throw new TaxModeError(
            "in-the-past",
            "Eine Umstellung kann nicht rückwirkend gelten.",
        );
    }

    return db.transaction(async (tx) => {
        const [clash] = await tx
            .select({ id: schema.taxModeHistory.id })
            .from(schema.taxModeHistory)
            .where(
                eq(schema.taxModeHistory.effectiveFrom, input.effectiveFrom),
            );

        if (clash) {
            throw new TaxModeError(
                "duplicate",
                "Für diesen Zeitpunkt ist bereits eine Umstellung geplant.",
            );
        }

        const [row] = await tx
            .insert(schema.taxModeHistory)
            .values({
                strategy: input.strategy,
                effectiveFrom: input.effectiveFrom,
                note: input.note?.trim() || null,
                createdByStaffId: actor.type === "staff" ? actor.id : null,
            })
            .returning();

        await audit(tx, {
            actor,
            action: "tax_mode.schedule",
            entityType: "tax_mode",
            entityId: row.id,
            after: {
                strategy: row.strategy,
                effectiveFrom: row.effectiveFrom.toISOString(),
                note: row.note,
            },
        });

        return row;
    });
}

/**
 * Withdraws a switch that has not taken effect yet. One that has is part of
 * the history of documents already finalized under it and stays.
 */
export async function cancelScheduledTaxMode(
    db: Db,
    id: string,
    actor: Actor,
    now = new Date(),
) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(schema.taxModeHistory)
            .where(
                and(
                    eq(schema.taxModeHistory.id, id),
                    gt(schema.taxModeHistory.effectiveFrom, now),
                ),
            )
            .for("update");

        if (!row) {
            throw new TaxModeError(
                "not-scheduled",
                "Diese Umstellung ist bereits wirksam und kann nicht mehr zurückgenommen werden.",
            );
        }

        await tx
            .delete(schema.taxModeHistory)
            .where(eq(schema.taxModeHistory.id, id));

        await audit(tx, {
            actor,
            action: "tax_mode.cancel",
            entityType: "tax_mode",
            entityId: id,
            before: {
                strategy: row.strategy,
                effectiveFrom: row.effectiveFrom.toISOString(),
            },
        });

        return row;
    });
}
