import {
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";
import { staffUser } from "./staff";

/**
 * Which tax strategy is in force, and since when.
 *
 * A switch is a row with a future `effective_from`, not an edit of a setting:
 * § 19 UStG stops applying on a date, and every invoice finalized before that
 * date has to go on saying that no VAT was charged. The resolver picks the
 * row with the latest `effective_from` that is not after the moment a
 * document is finalized, so switching is never retroactive and the history
 * stays readable years later.
 */
export const taxModeHistory = pgTable(
    "tax_mode_history",
    {
        id: ulidPk("taxmode"),
        /**
         * The strategy id from `src/server/tax` — `kleinunternehmer` or
         * `regular-vat`. Text rather than a Postgres enum: adding a strategy
         * is a module, and a migration to widen an enum would be the only
         * thing standing between the code and the database.
         */
        strategy: text("strategy").notNull(),
        /** From this instant on, documents are finalized under `strategy`. */
        effectiveFrom: timestamp("effective_from").notNull(),
        /** Why the switch was scheduled. Shown in the admin history. */
        note: text("note"),
        /** Who scheduled it; null for the row the migration seeded. */
        createdByStaffId: ulidFk("created_by_staff_id").references(
            () => staffUser.id,
            { onDelete: "set null" },
        ),
        ...timestamps(),
    },
    (table) => [
        // Unique, not merely indexed: two rows with the same instant would
        // make "which strategy was in force" a question with two answers.
        uniqueIndex("tax_mode_history_effective_from_idx").on(
            table.effectiveFrom,
        ),
    ],
);

/**
 * One row per § 19 threshold warning that has already gone out, so a second
 * invoice on the same day does not send the same mail again. The unique index
 * on (year, metric, level) is what makes the notification idempotent — the
 * insert either wins or conflicts, and only the winner sends.
 */
export const revenueNotice = pgTable(
    "revenue_notice",
    {
        id: ulidPk("revenuenotice"),
        /** Calendar year the warning is about. */
        year: integer("year").notNull(),
        /** `previous` or `current` — which of the two § 19 limits it is. */
        metric: text("metric").notNull(),
        /** 80 or 100, in percent of that limit. */
        level: integer("level").notNull(),
        /** The net revenue that triggered it, in cents — for the audit trail. */
        netCents: integer("net_cents").notNull(),
        limitCents: integer("limit_cents").notNull(),
        notifiedAt: timestamp("notified_at").notNull().defaultNow(),
        ...timestamps(),
    },
    (table) => [
        uniqueIndex("revenue_notice_year_metric_level_idx").on(
            table.year,
            table.metric,
            table.level,
        ),
        index("revenue_notice_year_idx").on(table.year),
    ],
);

export type TaxModeHistory = typeof taxModeHistory.$inferSelect;
export type RevenueNotice = typeof revenueNotice.$inferSelect;
