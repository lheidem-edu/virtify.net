import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function connectionString() {
    const url = process.env.DATABASE_URL;

    if (!url) {
        throw new Error(
            "DATABASE_URL is not set. Run `npm run db:up` and copy the printed value into .env.local.",
        );
    }

    return url;
}

/**
 * One pool per process. Next's dev server re-evaluates modules on every
 * change, so the pool is cached on globalThis — otherwise each edit would
 * leak a pool and the database would run out of connections.
 */
const globalForDb = globalThis as unknown as { pool?: Pool };

const pool =
    globalForDb.pool ?? new Pool({ connectionString: connectionString() });

if (process.env.NODE_ENV !== "production") {
    globalForDb.pool = pool;
}

export const db = drizzle(pool, { schema });
export { schema };
