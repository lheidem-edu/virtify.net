import { execSync } from "node:child_process";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "@/db/schema";

/**
 * A throwaway database for the integration tests.
 *
 * Scoping, permissions and API-key reach are claims about what a query
 * returns, and a mock cannot be wrong about that in the way Postgres can.
 * So these tests run against a real server — the one `npm run db:up` starts
 * — in a database of their own that is created, migrated and dropped per run.
 *
 * With no server reachable they are skipped rather than failed: a machine
 * without Docker should still be able to run `npm run test` and see the unit
 * suite pass. The skip is loud, so it cannot quietly become the normal case.
 */

export type TestDb = ReturnType<typeof drizzle<typeof schema>> & {
    $pool: Pool;
};

function adminUrl(): string | null {
    const url =
        process.env.TEST_DATABASE_URL ??
        process.env.DATABASE_URL ??
        readEnvFile();

    return url ?? null;
}

/** `.env.local` is not loaded by vitest, so the URL is read from it here. */
function readEnvFile(): string | null {
    try {
        const text = execSync("cat .env.local", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });

        return (
            text
                .split("\n")
                .find((line) => line.startsWith("DATABASE_URL="))
                ?.slice("DATABASE_URL=".length)
                .trim()
                .replace(/^["']|["']$/g, "") ?? null
        );
    } catch {
        return null;
    }
}

export async function databaseAvailable(): Promise<boolean> {
    const url = adminUrl();

    if (!url) {
        return false;
    }

    const pool = new Pool({ connectionString: url, max: 1 });

    try {
        await pool.query("select 1");

        return true;
    } catch {
        return false;
    } finally {
        await pool.end();
    }
}

/**
 * Creates `virtify_test_<random>`, applies every migration to it and hands
 * back a Drizzle instance. The name is random so two runs at once — a watch
 * mode and a terminal — cannot tread on each other.
 */
export async function createTestDatabase(): Promise<{
    db: TestDb;
    drop: () => Promise<void>;
}> {
    const url = adminUrl();

    if (!url) {
        throw new Error("no database url");
    }

    const name = `virtify_test_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new Pool({ connectionString: url, max: 1 });

    await admin.query(`create database "${name}"`);
    await admin.end();

    const target = new URL(url);
    target.pathname = `/${name}`;

    // Room for the concurrency proofs: the gapless-numbering test opens
    // twenty transactions at once and needs a connection for each.
    const pool = new Pool({ connectionString: target.toString(), max: 25 });

    // A pool whose server goes away emits on the pool, not on the query. The
    // database is dropped out from under it at the end of every run, so
    // without this the teardown ends as an unhandled error.
    pool.on("error", () => {});
    const db = drizzle(pool, { schema }) as TestDb;

    db.$pool = pool;

    await migrate(db, { migrationsFolder: "./drizzle" });

    return {
        db,
        drop: async () => {
            await pool.end();

            const cleanup = new Pool({ connectionString: url, max: 1 });

            // Nothing else holds a connection by now, but a stray one would
            // make the drop fail and leave the database behind.
            await cleanup.query(
                `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
                [name],
            );
            await cleanup.query(`drop database if exists "${name}"`);
            await cleanup.end();
        },
    };
}

export { schema };
