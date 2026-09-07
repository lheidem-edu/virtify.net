/**
 * Creates the first employee account, the one there is nobody to invite from.
 *
 *   npm run staff:add -- "Luca Heidemann" kontakt@virtify.net
 *
 * Everyone after that is invited under Verwaltung > Mitarbeiter. The account
 * is created without a usable password and the invitation is mailed to the
 * address, so this needs a working relay — with none configured it prints the
 * set-password link instead of pretending the mail went out.
 */
import {
    createStaffAccount,
    findStaffAccount,
    sendStaffInvite,
} from "@/lib/staff-accounts";

const name = process.argv[2]?.trim();
const email = process.argv[3]?.trim().toLowerCase();

if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('usage: npm run staff:add -- "Name" address@example.net');
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error(
        "DATABASE_URL is not set. Run `npm run db:up` and put the printed value in .env.local.",
    );
    process.exit(1);
}

if (await findStaffAccount(email)) {
    console.error(`${email} already has an employee account.`);
    process.exit(1);
}

const user = await createStaffAccount({ name, email });
console.log(`created ${user.email} (${user.id})`);

try {
    await sendStaffInvite(email);
    console.log("invitation sent; the link in it sets the password.");
} catch (error) {
    console.error(
        `\nThe invitation could not be sent: ${(error as Error).message}`,
    );
    console.error(
        "The account exists but has no usable password. Send the invitation\n" +
            "again from Verwaltung > Mitarbeiter once mail works, or use\n" +
            '"Passwort vergessen" at /admin/login.',
    );
    process.exit(1);
}

process.exit(0);
