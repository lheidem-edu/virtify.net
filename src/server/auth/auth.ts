import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { db, schema } from "@/db";
import { site } from "@/lib/site";
import { createId } from "@/lib/ulid";
import {
    sendPasswordResetMail,
    sendVerificationMail,
} from "@/server/auth/mail";
import {
    createCustomerForUser,
    customerForUser,
} from "@/server/customers/repository";

function secret() {
    const value = process.env.BETTER_AUTH_SECRET;

    if (!value) {
        throw new Error(
            "BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32`.",
        );
    }

    return value;
}

export const auth = betterAuth({
    appName: site.name,
    secret: secret(),
    baseURL: process.env.BETTER_AUTH_URL ?? site.url,

    database: drizzleAdapter(db, {
        provider: "pg",
        schema: {
            user: schema.user,
            session: schema.session,
            account: schema.account,
            verification: schema.verification,
            twoFactor: schema.twoFactor,
            rateLimit: schema.rateLimit,
        },
    }),

    emailAndPassword: {
        enabled: true,
        // Password hashing stays on Better Auth's scrypt: OWASP-approved and
        // pure JavaScript, so the container builds without a compiler.
        minPasswordLength: 12,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
            await sendPasswordResetMail({
                to: user.email,
                name: user.name,
                url,
            });
        },
    },

    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
            await sendVerificationMail({
                to: user.email,
                name: user.name,
                url,
            });
        },
    },

    user: {
        // No master data here any more: a login is a login. Company, address
        // and VAT ID belong to the billing account — see src/db/schema/customers.ts.
        changeEmail: {
            enabled: true,
            // The address only changes once the new one is confirmed, so a
            // typo cannot lock anybody out of their account.
            sendChangeEmailVerification: async ({
                user,
                newEmail,
                url,
            }: {
                user: { name?: string | null };
                newEmail: string;
                url: string;
            }) => {
                await sendVerificationMail({
                    to: newEmail,
                    name: user.name,
                    url,
                    heading: "Neue E-Mail-Adresse bestätigen",
                });
            },
        },
    },

    databaseHooks: {
        user: {
            create: {
                /**
                 * Every login gets a billing account the moment it exists.
                 * Doing it here rather than in the registration action means
                 * a login created by any other route — a seed, a later
                 * invitation flow — still has one, and a login that can sign
                 * in but owns nothing never happens.
                 */
                after: async (created: {
                    id: string;
                    name: string;
                    email: string;
                }) => {
                    await db.transaction(async (tx) => {
                        const existing = await customerForUser(tx, created.id);

                        if (!existing) {
                            await createCustomerForUser(tx, created);
                        }
                    });
                },
            },
        },
    },

    // Counters live in the database so they survive restarts and hold across
    // more than one instance.
    rateLimit: {
        enabled: true,
        storage: "database",
        window: 60,
        max: 20,
        customRules: {
            "/sign-in/email": { window: 300, max: 5 },
            "/sign-up/email": { window: 3600, max: 5 },
            "/forget-password": { window: 3600, max: 5 },
            "/two-factor/verify-totp": { window: 300, max: 5 },
        },
    },

    advanced: {
        database: {
            generateId: ({ model }) => {
                const prefixes: Record<string, Parameters<typeof createId>[0]> =
                    {
                        user: "user",
                        session: "session",
                        account: "account",
                        verification: "verification",
                        twoFactor: "twofactor",
                    };

                return createId(prefixes[model] ?? "verification");
            },
        },
    },

    plugins: [
        twoFactor({
            issuer: site.name,
            otpOptions: { period: 30 },
        }),
    ],
});

export type Session = typeof auth.$Infer.Session;
