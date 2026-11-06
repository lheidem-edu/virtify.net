import { describe, expect, it } from "vitest";
import { type EnvSource, loadEnv } from "@/lib/env";

const KEY = Buffer.from("test-key-a-exactly-32-bytes-long").toString("base64");

const minimal = {
    DATABASE_URL: "postgres://virtify:virtify@localhost:5433/virtify",
    BETTER_AUTH_URL: "https://virtify.net",
    BETTER_AUTH_SECRET: "a-signing-secret",
    APP_ENCRYPTION_KEY: KEY,
} satisfies EnvSource;

describe("loadEnv", () => {
    it("accepts a minimal configuration and fills the rest in", () => {
        const env = loadEnv(minimal);

        expect(env.DATABASE_URL).toBe(minimal.DATABASE_URL);
        expect(env.NODE_ENV).toBe("development");
        expect(env.PAYPAL_ENV).toBe("sandbox");
        expect(env.STRIPE_SECRET_KEY).toBe("");
        expect(env.PAYPAL_VAULTING_ENABLED).toBe(false);
    });

    it("names the variable and says what it is for when one is missing", () => {
        const { DATABASE_URL: _omitted, ...without } = minimal;

        expect(() => loadEnv(without)).toThrow(/DATABASE_URL/);
        expect(() => loadEnv(without)).toThrow(/PostgreSQL connection string/);
        expect(() => loadEnv(without)).toThrow(/\.env\.example/);
    });

    it("reports every problem at once, not just the first", () => {
        let message = "";

        try {
            loadEnv({ ...minimal, DATABASE_URL: "", BETTER_AUTH_SECRET: "" });
        } catch (error) {
            message = (error as Error).message;
        }

        expect(message).toContain("DATABASE_URL");
        expect(message).toContain("BETTER_AUTH_SECRET");
    });

    it("insists on an absolute http(s) origin for auth links", () => {
        expect(() =>
            loadEnv({ ...minimal, BETTER_AUTH_URL: "virtify.net" }),
        ).toThrow(/absolute http/);
        expect(() =>
            loadEnv({ ...minimal, BETTER_AUTH_URL: "ftp://virtify.net" }),
        ).toThrow(/absolute http/);
        expect(
            loadEnv({ ...minimal, BETTER_AUTH_URL: "http://localhost:3000" })
                .BETTER_AUTH_URL,
        ).toBe("http://localhost:3000");
    });

    it("insists on a 32-byte encryption key", () => {
        expect(() =>
            loadEnv({ ...minimal, APP_ENCRYPTION_KEY: "short" }),
        ).toThrow(/32 bytes/);
        expect(
            loadEnv({
                ...minimal,
                APP_ENCRYPTION_KEY: "a".repeat(64),
            }).APP_ENCRYPTION_KEY,
        ).toBe("a".repeat(64));
    });

    it("rejects a PayPal environment that is neither sandbox nor live", () => {
        // Guessing from NODE_ENV is how a live key ends up talking to sandbox.
        expect(() => loadEnv({ ...minimal, PAYPAL_ENV: "production" })).toThrow(
            /PAYPAL_ENV/,
        );
    });

    it("reads a boolean switch the way a shell writes one", () => {
        for (const value of ["true", "1"]) {
            expect(
                loadEnv({ ...minimal, PAYPAL_VAULTING_ENABLED: value })
                    .PAYPAL_VAULTING_ENABLED,
            ).toBe(true);
        }

        for (const value of ["false", "0", ""]) {
            expect(
                loadEnv({ ...minimal, PAYPAL_VAULTING_ENABLED: value })
                    .PAYPAL_VAULTING_ENABLED,
            ).toBe(false);
        }

        // "yes" is not a value we silently read as true.
        expect(() =>
            loadEnv({ ...minimal, PAYPAL_VAULTING_ENABLED: "yes" }),
        ).toThrow(/PAYPAL_VAULTING_ENABLED/);
    });
});
