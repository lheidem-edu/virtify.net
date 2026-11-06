import { integer, text, timestamp } from "drizzle-orm/pg-core";
import { createId, type IdPrefix } from "@/lib/ulid";

/**
 * The column shapes every table is built from. Defining them once is what
 * makes the hard rules in CLAUDE.md enforceable rather than a convention each
 * new table has to remember.
 */

/**
 * Primary key: a prefixed ULID in a `text` column, minted by the application
 * rather than the database, so a row knows its own id before it is inserted
 * and a multi-table write needs no round trip in the middle.
 */
export function ulidPk(prefix: IdPrefix) {
    return text("id")
        .primaryKey()
        .$defaultFn(() => createId(prefix));
}

/**
 * Foreign key column. The caller still chains `.references()`, because what it
 * points at and what happens on delete belong with the table, not here. This
 * exists so the id columns are declared as ids and would all change together
 * if the representation ever did.
 */
export function ulidFk(name: string) {
    return text(name);
}

/**
 * Money is whole minor units — cents — and `integer` holds ±21 million euro,
 * far past anything this bills. Arithmetic on it belongs in src/lib/money.ts,
 * never in SQL and never in a float.
 */
export function money(name: string) {
    return integer(name);
}

/**
 * The pair every table carries.
 *
 * Note: these are `timestamp`, not `timestamptz`, which is what the tables
 * already hold and what CLAUDE.md rule 9 says they should not be. Changing it
 * is one migration that rewrites every timestamp column in the database at
 * once, so it is tracked in docs/PROGRESS.md instead of being smuggled in
 * here — the helper deliberately matches what is on disk today.
 */
export function timestamps() {
    return {
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    };
}
