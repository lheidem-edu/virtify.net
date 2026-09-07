#!/usr/bin/env node
/**
 * Grants or revokes the admin role. There is deliberately no way to become an
 * admin through the web interface — the first one has to be made here, with
 * access to the server. Everyone after that is invited under Verwaltung >
 * Mitarbeiter.
 *
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:revoke -- someone@example.com
 *
 * An employee is not a customer: granting the role releases the customer
 * number and clears the master data, and it refuses outright while the account
 * still holds contracts, offers or invoices — those documents name a
 * Kundennummer that has to keep meaning something. Revoking hands out a fresh
 * customer number; the master data has to be filled in again, by the customer
 * or under Verwaltung > Kunden.
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

/** Mirrors CUSTOMER_NUMBER_START in src/lib/documents/numbering.ts. */
const CUSTOMER_NUMBER_START = 10000;

const client = new Client({ connectionString });
await client.connect();

try {
    const { rows: found } = await client.query(
        'SELECT id, email, role FROM "user" WHERE lower(email) = $1',
        [email],
    );

    if (found.length === 0) {
        console.error(`No account found for ${email}.`);
        process.exit(1);
    }

    const [account] = found;

    if (account.role === role) {
        console.log(`${account.email} is already "${role}" (${account.id}).`);
        process.exit(0);
    }

    if (role === "admin") {
        const { rows: held } = await client.query(
            `SELECT
                (SELECT count(*) FROM contract WHERE user_id = $1) AS contracts,
                (SELECT count(*) FROM offer    WHERE user_id = $1) AS offers,
                (SELECT count(*) FROM invoice  WHERE user_id = $1) AS invoices`,
            [account.id],
        );

        const [documents] = held;
        const total =
            Number(documents.contracts) +
            Number(documents.offers) +
            Number(documents.invoices);

        if (total > 0) {
            console.error(
                `${account.email} still holds ${documents.contracts} contract(s), ` +
                    `${documents.offers} offer(s) and ${documents.invoices} invoice(s).\n` +
                    "An employee account has no customer number, so those documents\n" +
                    "would lose the number they were issued under. Move them to another\n" +
                    "account first, or invite the employee under a separate address.",
            );
            process.exit(1);
        }

        const { rows } = await client.query(
            `UPDATE "user" SET
                role = 'admin',
                customer_number = NULL,
                company = NULL,
                street = NULL,
                postal_code = NULL,
                city = NULL,
                country = NULL,
                vat_id = NULL,
                phone = NULL,
                buyer_reference = NULL,
                updated_at = now()
             WHERE id = $1
             RETURNING email, role`,
            [account.id],
        );

        const [updated] = rows;
        console.log(
            `${updated.email} is now "${updated.role}" (${account.id}); customer number and master data released.`,
        );
    } else {
        // The counter is the same one sign-ups draw from, so a demoted account
        // never gets a number a customer already has.
        const { rows: counter } = await client.query(
            `INSERT INTO document_counter (scope, value)
             VALUES ('customer', $1)
             ON CONFLICT (scope) DO UPDATE SET value = document_counter.value + 1
             RETURNING value`,
            [CUSTOMER_NUMBER_START + 1],
        );

        const { rows } = await client.query(
            `UPDATE "user" SET role = 'user', customer_number = $2, updated_at = now()
             WHERE id = $1
             RETURNING email, role, customer_number`,
            [account.id, counter[0].value],
        );

        const [updated] = rows;
        console.log(
            `${updated.email} is now "${updated.role}" (${account.id}) with customer number ${updated.customer_number}; the master data is empty.`,
        );
    }
} finally {
    await client.end();
}
