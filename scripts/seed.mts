/**
 * Fills an empty database with enough to work in: the Super Admin role, one
 * employee holding it, and three demo customers.
 *
 *   npm run seed -- "Luca Heidemann" kontakt@virtify.net
 *
 * Safe to run twice — every step checks first and skips what is already
 * there, so it can be used to repair a database as well as to start one.
 * The employee is created without a usable password, exactly as
 * `npm run staff:add` does; the set-password link is printed when no mail
 * relay is configured.
 *
 * Demo customers are only created when there are none at all, so this cannot
 * litter a database that is already in use.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
    ALL_PERMISSIONS,
    SUPER_ADMIN_ROLE,
    WILDCARD,
} from "@/server/auth/permissions";
import {
    createStaffAccount,
    findStaffAccount,
    sendStaffInvite,
} from "@/server/auth/staff-accounts";
import { createCustomer } from "@/server/customers/repository";
import type { CustomerInput } from "@/server/customers/schema";

const name = process.argv[2]?.trim();
const email = process.argv[3]?.trim().toLowerCase();

if (!process.env.DATABASE_URL) {
    console.error(
        "DATABASE_URL is not set. Run `npm run db:up` and put the printed value in .env.local.",
    );
    process.exit(1);
}

const DEMO: CustomerInput[] = [
    {
        kind: "company",
        name: "Jana Brinkmann",
        company: "Nordlicht Medien GmbH",
        street: "Hafenstraße 12",
        postalCode: "24103",
        city: "Kiel",
        country: "DE",
        vatId: "DE811234567",
        phone: "+49 431 1234567",
        buyerReference: null,
        currency: "EUR",
        language: "de",
        status: "active",
        notes: "Zahlt per Überweisung, Rechnung bitte als PDF.",
    },
    {
        kind: "private",
        name: "Tobias Weber",
        company: null,
        street: "Lindenallee 4",
        postalCode: "04277",
        city: "Leipzig",
        country: "DE",
        vatId: null,
        phone: null,
        buyerReference: null,
        currency: "EUR",
        language: "de",
        status: "active",
        notes: null,
    },
    {
        kind: "company",
        name: "Markus Hofer",
        company: "Alpstein Software OG",
        street: "Innstraße 22",
        postalCode: "6020",
        city: "Innsbruck",
        country: "AT",
        vatId: "ATU12345678",
        phone: null,
        buyerReference: null,
        currency: "EUR",
        language: "de",
        // Here so the admin list's status filter has something to filter.
        status: "suspended",
        notes: "Zahlungsrückstand aus 2026, Leistungen pausiert.",
    },
];

const SYSTEM = { type: "system", label: "seed" } as const;

async function ensureSuperAdminRole() {
    const [existing] = await db
        .select()
        .from(schema.staffRole)
        .where(eq(schema.staffRole.name, SUPER_ADMIN_ROLE));

    if (existing) {
        return existing;
    }

    const [row] = await db
        .insert(schema.staffRole)
        .values({
            name: SUPER_ADMIN_ROLE,
            description:
                "Darf alles. Kann nicht gelöscht oder eingeschränkt werden.",
            permissions: [WILDCARD],
            isSystem: true,
        })
        .returning();

    console.log(
        `role "${SUPER_ADMIN_ROLE}" created — covers all ${ALL_PERMISSIONS.length} permissions`,
    );

    return row;
}

const role = await ensureSuperAdminRole();

if (name && email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        console.error('usage: npm run seed -- "Name" address@example.net');
        process.exit(1);
    }

    let account = await findStaffAccount(email);

    if (account) {
        console.log(`employee ${email} already exists`);
    } else {
        account = await createStaffAccount({ name, email });
        console.log(`employee ${account.email} created (${account.id})`);

        try {
            await sendStaffInvite(email);
            console.log("invitation sent; the link in it sets the password.");
        } catch (error) {
            console.error(
                `invitation not sent: ${(error as Error).message}\n` +
                    'Use "Passwort vergessen" at /admin/login once mail works.',
            );
        }
    }

    await db
        .insert(schema.staffRoleAssignment)
        .values({ staffUserId: account.id, roleId: role.id })
        .onConflictDoNothing();

    console.log(`${email} holds "${SUPER_ADMIN_ROLE}"`);
} else {
    console.log(
        'no employee given — pass a name and an address to create one:\n  npm run seed -- "Name" address@example.net',
    );
}

const [anyCustomer] = await db
    .select({ id: schema.customer.id })
    .from(schema.customer)
    .limit(1);

if (anyCustomer) {
    console.log("customers already exist — demo data skipped");
} else {
    for (const input of DEMO) {
        const row = await createCustomer(db, input, SYSTEM);
        console.log(
            `customer ${row.customerNumber} ${row.company || row.name}`,
        );
    }
}

process.exit(0);
