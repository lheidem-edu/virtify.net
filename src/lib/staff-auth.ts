import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { sendStaffInviteMail, sendStaffResetMail } from "@/lib/mail-auth";
import { site } from "@/lib/site";
import { isInvite, recordInvite } from "@/lib/staff-invite";

/**
 * The employees' authentication, entirely separate from the customers'. Its
 * own tables, its own cookie, its own two-factor secrets — which is what lets
 * one address be both: a customer account with a Kundennummer and invoices,
 * and an employee account with a password of its own. Neither knows about the
 * other, and neither password opens the other door.
 *
 * There is no sign-up. An employee account is created by invitation from
 * inside Verwaltung, or by scripts/staff-add.mjs for the first one, which is
 * why /api/staff-auth can be exposed without it being a way in.
 */

function secret() {
    const value = process.env.BETTER_AUTH_SECRET;

    if (!value) {
        throw new Error(
            "BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32`.",
        );
    }

    return value;
}

export const staffAuth = betterAuth({
    appName: `${site.name} Verwaltung`,
    secret: secret(),
    baseURL: process.env.BETTER_AUTH_URL ?? site.url,
    basePath: "/api/staff-auth",

    database: drizzleAdapter(db, {
        provider: "pg",
        schema: {
            user: schema.staffUser,
            session: schema.staffSession,
            account: schema.staffAccount,
            verification: schema.staffVerification,
            twoFactor: schema.staffTwoFactor,
            rateLimit: schema.staffRateLimit,
        },
    }),

    emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        // The only way an account comes into being is an invitation, so the
        // public endpoint has nothing to offer.
        disableSignUp: true,
        // Employees are invited rather than verified: the invitation goes to
        // the address and is the only way in, so control of the mailbox is
        // already what grants access.
        requireEmailVerification: false,
        sendResetPassword: async ({ user, url }) => {
            // An invitation and a forgotten password produce the same link;
            // only the wording differs. The outcome is recorded because
            // Better Auth swallows what this throws — see staff-invite.ts.
            if (isInvite(user.email)) {
                try {
                    await sendStaffInviteMail({
                        to: user.email,
                        name: user.name,
                        url,
                    });
                    recordInvite(user.email);
                } catch (error) {
                    recordInvite(user.email, error);
                    throw error;
                }
                return;
            }

            await sendStaffResetMail({
                to: user.email,
                name: user.name,
                url,
            });
        },
    },

    session: {
        // A session that reaches every customer's data should not outlive a
        // working week of not being used.
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
    },

    rateLimit: {
        enabled: true,
        storage: "database",
        window: 60,
        max: 20,
        customRules: {
            "/sign-in/email": { window: 300, max: 5 },
            "/forget-password": { window: 3600, max: 5 },
            "/request-password-reset": { window: 3600, max: 5 },
            "/two-factor/verify-totp": { window: 300, max: 5 },
        },
    },

    advanced: {
        // Its own cookie name, so a staff session and a customer session live
        // side by side in one browser rather than overwriting each other.
        cookiePrefix: "virtify-staff",
        database: {
            generateId: ({ model }) => {
                const prefixes: Record<string, Parameters<typeof createId>[0]> =
                    {
                        user: "staffuser",
                        session: "staffsession",
                        account: "staffaccount",
                        verification: "staffverification",
                        twoFactor: "stafftwofactor",
                    };

                return createId(prefixes[model] ?? "staffverification");
            },
        },
    },

    plugins: [
        twoFactor({
            issuer: `${site.name} Verwaltung`,
            otpOptions: { period: 30 },
        }),
    ],
});

export type StaffSession = typeof staffAuth.$Infer.Session;
