import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor } from "better-auth/plugins";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { sendPasswordResetMail, sendVerificationMail } from "@/lib/mail-auth";
import { site } from "@/lib/site";

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
        additionalFields: {
            company: { type: "string", required: false, input: true },
            street: { type: "string", required: false, input: true },
            postalCode: { type: "string", required: false, input: true },
            city: { type: "string", required: false, input: true },
            country: { type: "string", required: false, input: true },
            vatId: { type: "string", required: false, input: true },
            phone: { type: "string", required: false, input: true },
        },
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
        admin(),
    ],
});

export type Session = typeof auth.$Infer.Session;
