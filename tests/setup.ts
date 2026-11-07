import fs from "node:fs";
import path from "node:path";

/**
 * Vitest does not read `.env.local`, and `src/db` builds its pool while being
 * imported — so without this, importing anything that touches the database
 * throws before a single test runs. The pool opens no socket until a query,
 * so this costs nothing in the unit suite.
 */
const file = path.join(process.cwd(), ".env.local");

if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());

        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
        }
    }
}

// A value is still needed when there is no .env.local at all: the tests that
// want a real server check for one themselves and skip when it is absent.
process.env.DATABASE_URL ??= "postgres://localhost:5432/virtify_absent";
