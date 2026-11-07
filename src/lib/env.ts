import "server-only";
import { z } from "zod";

/**
 * Every environment variable the server reads, in one validated place. A typo
 * in a deployment's configuration should stop the container at boot with a
 * sentence that names the variable, not surface three weeks later as a
 * payment that was never collected.
 *
 * `src/instrumentation.ts` calls `assertEnv()` once per server start, which is
 * where the hard failure happens. Access through `env` validates lazily, so
 * `next build` — which has no secrets — is not held to the same bar.
 */

const nonEmpty = z.string().trim().min(1);

const httpUrl = nonEmpty.refine((value) => {
    try {
        const url = new URL(value);

        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}, "must be an absolute http(s) URL");

const base64Key32 = nonEmpty.refine((value) => {
    const bytes = /^[0-9a-f]{64}$/i.test(value)
        ? 32
        : Buffer.from(value, "base64").length;

    return bytes === 32;
}, "must be 32 bytes — generate one with `openssl rand -base64 32`");

const boolish = z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((value) => value === "true" || value === "1");

const schema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    // --- Database -------------------------------------------------------
    DATABASE_URL: nonEmpty.describe(
        "PostgreSQL connection string; `npm run db:up` prints a local one",
    ),

    // --- Authentication -------------------------------------------------
    BETTER_AUTH_URL: httpUrl.describe(
        "Public origin; verification and reset links are built from it",
    ),
    BETTER_AUTH_SECRET: nonEmpty.describe(
        "Signing key for sessions and tokens",
    ),

    // --- Secrets at rest ------------------------------------------------
    APP_ENCRYPTION_KEY: base64Key32.describe(
        "AES-256-GCM key for gateway credentials and service passwords",
    ),
    APP_ENCRYPTION_KEY_OLD: z.string().optional().default(""),

    // --- Documents ------------------------------------------------------
    DOCUMENT_STORAGE_PATH: z
        .string()
        .trim()
        .optional()
        .default(".data/documents")
        .describe(
            "Directory the rendered invoice and credit note PDFs are kept in; " +
                "mount it as a volume, or a redeploy takes the documents with it",
        ),

    // --- Mail -----------------------------------------------------------
    VIRTIFY_SMTP_HOST: z.string().optional().default(""),
    VIRTIFY_SMTP_EHLO: z.string().optional().default(""),

    // --- Payments (optional; without keys the buttons stay hidden) -------
    STRIPE_SECRET_KEY: z.string().optional().default(""),
    STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
    PAYPAL_ENV: z.enum(["sandbox", "live"]).optional().default("sandbox"),
    PAYPAL_CLIENT_ID: z.string().optional().default(""),
    PAYPAL_CLIENT_SECRET: z.string().optional().default(""),
    PAYPAL_WEBHOOK_ID: z.string().optional().default(""),
    PAYPAL_VAULTING_ENABLED: boolish,
});

export type Env = z.infer<typeof schema>;

let parsed: Env | null = null;

function describeFailure(error: z.ZodError): string {
    const lines = error.issues.map((issue) => {
        const name = issue.path.join(".") || "(root)";
        const hint =
            schema.shape[name as keyof typeof schema.shape]?.description;

        return hint
            ? `  ${name}: ${issue.message} — ${hint}`
            : `  ${name}: ${issue.message}`;
    });

    return [
        "Invalid environment configuration:",
        ...lines,
        "",
        "See .env.example for what each variable is for.",
    ].join("\n");
}

export type EnvSource = Record<string, string | undefined>;

export function loadEnv(source: EnvSource = process.env): Env {
    const result = schema.safeParse(source);

    if (!result.success) {
        throw new Error(describeFailure(result.error));
    }

    return result.data;
}

/** Called once from instrumentation.ts, so a misconfigured boot fails loudly. */
export function assertEnv(): Env {
    parsed ??= loadEnv();

    return parsed;
}

/**
 * Reads validate the whole environment on first access and are typed and
 * defaulted from then on, so no call site has to repeat `?? ""`.
 */
export const env: Env = new Proxy({} as Env, {
    get(_target, key: string) {
        return assertEnv()[key as keyof Env];
    },
    has(_target, key: string) {
        return key in assertEnv();
    },
    ownKeys() {
        return Reflect.ownKeys(assertEnv());
    },
    getOwnPropertyDescriptor(_target, key: string) {
        return {
            value: assertEnv()[key as keyof Env],
            enumerable: true,
            configurable: true,
        };
    },
});
