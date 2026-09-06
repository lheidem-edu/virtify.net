#!/usr/bin/env node
/**
 * Applies pending migrations, then exits. Runs from `npm start` before the
 * server binds, so the container never serves traffic against a schema the
 * code does not expect.
 *
 * Uses the migrator from `drizzle-orm`, not drizzle-kit: drizzle-kit is a
 * devDependency and is absent from a production image built with
 * `npm ci --omit=dev`. Both write the same drizzle.__drizzle_migrations
 * table, so the two are interchangeable against an existing database.
 *
 * The `drizzle/` directory must be present in the image — it holds the SQL
 * and the journal that says which migrations exist.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Arbitrary but fixed. Two containers starting together — a rolling deploy,
 * or more than one replica — would otherwise try to apply the same migration
 * at the same time; the second blocks here until the first is done and then
 * finds nothing left to do.
 */
const LOCK_KEY = 8_147_293_005_117_442n;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error(
        "[migrate] DATABASE_URL is not set. Refusing to start without it.",
    );
    process.exit(1);
}

const pool = new Pool({ connectionString, max: 1 });
let locked = false;

try {
    const client = await pool.connect();

    try {
        await client.query("SELECT pg_advisory_lock($1)", [
            LOCK_KEY.toString(),
        ]);
        locked = true;

        const started = Date.now();
        await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
        console.log(`[migrate] schema up to date in ${Date.now() - started}ms`);
    } finally {
        if (locked) {
            await client.query("SELECT pg_advisory_unlock($1)", [
                LOCK_KEY.toString(),
            ]);
        }
        client.release();
    }
} catch (error) {
    // Exit non-zero so `npm start` stops here and the container is restarted
    // rather than serving against a half-migrated database.
    console.error("[migrate] failed:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
