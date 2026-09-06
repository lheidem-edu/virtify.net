#!/usr/bin/env node
/**
 * Grants or revokes the admin role. There is deliberately no way to become an
 * admin through the web interface — the first one has to be made here, with
 * access to the server.
 *
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:revoke -- someone@example.com
 */
import { Client } from "pg";

const email = process.argv[3]?.trim().toLowerCase();
const role = process.argv[2] === "revoke" ? "user" : "admin";

if (!email) {
    console.error("usage: node scripts/grant-admin.mjs <grant|revoke> <email>");
    process.exit(1);
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error(
        "DATABASE_URL is not set. Run `npm run db:up` and put the printed value in .env.local.",
    );
    process.exit(1);
}

const client = new Client({ connectionString });
await client.connect();

try {
    const { rows } = await client.query(
        'UPDATE "user" SET role = $1, updated_at = now() WHERE lower(email) = $2 RETURNING id, email, role',
        [role, email],
    );

    if (rows.length === 0) {
        console.error(`No account found for ${email}.`);
        process.exitCode = 1;
    } else {
        const [user] = rows;
        console.log(`${user.email} is now "${user.role}" (${user.id})`);
    }
} finally {
    await client.end();
}
