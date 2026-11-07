import "server-only";
import { cache } from "react";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { site } from "@/lib/site";

/**
 * Where a gateway's credentials come from, and in what shape.
 *
 * Two sources, on purpose. The environment is what a developer has in
 * `.env.local` and what a container is handed at boot; the database is what
 * the operator can change in `/admin/settings/payments` without a deployment.
 * The row wins when it has credentials, the environment fills in otherwise —
 * so turning this on in production is adding a row, and nothing breaks for
 * anybody who never does.
 *
 * Hard rule 6: what is in the row is **encrypted at rest**, AES-256-GCM
 * through `src/lib/crypto.ts` with `APP_ENCRYPTION_KEY`. One blob rather than
 * a column per secret, because the shape of what Stripe needs is not the
 * shape of what PayPal needs, and because a column is one `select *` away
 * from a log line.
 *
 * Nothing in this module may be imported from a client component. The
 * decrypted values never leave the server, never reach an audit entry's
 * `before`/`after`, and never appear in a thrown message.
 */

export type GatewayId = "stripe" | "paypal" | "banktransfer";

export const GATEWAY_IDS: GatewayId[] = ["stripe", "paypal", "banktransfer"];

export const GATEWAY_LABEL: Record<GatewayId, string> = {
    stripe: "Kreditkarte (Stripe)",
    paypal: "PayPal",
    banktransfer: "Überweisung",
};

export type GatewayMode = "sandbox" | "live";

/** How PayPal is asked to collect a renewal. */
export type PayPalRecurringMode = "vault" | "subscriptions";

export const PAYPAL_RECURRING_MODE_LABEL: Record<PayPalRecurringMode, string> =
    {
        vault: "Vault — gespeicherte PayPal-Zahlungsquelle belasten",
        subscriptions: "Subscriptions — PayPal führt den Zeitplan",
    };

export type StripeCredentials = {
    secretKey: string;
    webhookSecret: string;
};

export type PayPalCredentials = {
    clientId: string;
    clientSecret: string;
    webhookId: string;
};

type Credentials = {
    stripe: StripeCredentials;
    paypal: PayPalCredentials;
    banktransfer: Record<string, never>;
};

export type GatewayConfig<Id extends GatewayId = GatewayId> = {
    id: Id;
    label: string;
    /** The operator has switched it on and it has what it needs. */
    enabled: boolean;
    mode: GatewayMode;
    credentials: Credentials[Id];
    /** Where the credentials came from; shown in the admin area. */
    source: "database" | "environment";
    /** PayPal only. */
    paypalRecurringMode: PayPalRecurringMode;
};

const CONTEXT = (id: GatewayId) => `payment_gateway.${id}.credentials`;

function emptyCredentials(id: GatewayId): Credentials[GatewayId] {
    switch (id) {
        case "stripe":
            return { secretKey: "", webhookSecret: "" };
        case "paypal":
            return { clientId: "", clientSecret: "", webhookId: "" };
        default:
            return {};
    }
}

/**
 * The environment's answer. Trimmed, because a trailing newline in a
 * `.env.local` is the single most common way a key "does not work".
 */
function fromEnvironment(id: GatewayId): {
    credentials: Credentials[GatewayId];
    mode: GatewayMode;
    present: boolean;
} {
    if (id === "stripe") {
        const credentials = {
            secretKey: env.STRIPE_SECRET_KEY.trim(),
            webhookSecret: env.STRIPE_WEBHOOK_SECRET.trim(),
        };

        return {
            credentials,
            // Stripe says which world a key belongs to in the key itself, so
            // there is nothing to configure and nothing to get wrong.
            mode: credentials.secretKey.startsWith("sk_live_")
                ? "live"
                : "sandbox",
            present: credentials.secretKey !== "",
        };
    }

    if (id === "paypal") {
        const credentials = {
            clientId: env.PAYPAL_CLIENT_ID.trim(),
            clientSecret: env.PAYPAL_CLIENT_SECRET.trim(),
            webhookId: env.PAYPAL_WEBHOOK_ID.trim(),
        };

        return {
            credentials,
            mode: env.PAYPAL_ENV === "live" ? "live" : "sandbox",
            present:
                credentials.clientId !== "" && credentials.clientSecret !== "",
        };
    }

    // Bank transfer needs no credentials — the IBAN is in the settings and is
    // not a secret; it is printed on every invoice.
    return { credentials: {}, mode: "live", present: true };
}

function hasWhatItNeeds(
    id: GatewayId,
    credentials: Credentials[GatewayId],
): boolean {
    if (id === "stripe") {
        return (credentials as StripeCredentials).secretKey !== "";
    }

    if (id === "paypal") {
        const paypal = credentials as PayPalCredentials;

        return paypal.clientId !== "" && paypal.clientSecret !== "";
    }

    return true;
}

function recurringMode(value: string | null | undefined): PayPalRecurringMode {
    if (value === "vault" || value === "subscriptions") {
        return value;
    }

    // Charging a stored PayPal wallet needs "reference transactions", which
    // PayPal grants per account on request and not by default. Without that
    // approval every charge fails with
    // MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION at the worst possible
    // moment, so the default is the mode that works for everybody.
    return env.PAYPAL_VAULTING_ENABLED ? "vault" : "subscriptions";
}

/**
 * Cached per request: a rendered page asks several times which gateways
 * exist, and each ask would otherwise be a query and a decryption.
 */
export const loadGatewayConfigs = cache(
    async (): Promise<Record<GatewayId, GatewayConfig>> => {
        let rows: (typeof schema.paymentGatewaySetting.$inferSelect)[] = [];

        try {
            rows = await db.select().from(schema.paymentGatewaySetting);
        } catch (error) {
            // A page must still render when the database is briefly
            // unreachable. Falling back to the environment is the same
            // decision `loadSettings` makes, for the same reason.
            console.error(
                "[payments] falling back to the environment for the gateway configuration:",
                error,
            );
        }

        const byId = new Map(rows.map((row) => [row.id, row]));

        const entries = GATEWAY_IDS.map((id) => {
            const row = byId.get(id);
            const environment = fromEnvironment(id);

            let credentials = environment.credentials;
            let source: GatewayConfig["source"] = "environment";
            let mode = environment.mode;

            if (row?.credentials) {
                try {
                    credentials = JSON.parse(
                        decrypt(row.credentials, CONTEXT(id)),
                    ) as Credentials[GatewayId];
                    source = "database";
                    mode = row.mode;
                } catch (error) {
                    // A blob that will not open is a configuration fault, not
                    // a reason to quietly fall back to a *different* account's
                    // keys: the gateway is reported as unconfigured instead.
                    console.error(
                        `[payments] the stored ${id} credentials could not be decrypted:`,
                        error,
                    );
                    credentials = emptyCredentials(id);
                    source = "database";
                }
            }

            const usable = hasWhatItNeeds(id, credentials);

            return [
                id,
                {
                    id,
                    label: GATEWAY_LABEL[id],
                    // A row that exists decides; without one, a gateway is on
                    // as soon as it has keys, which is what made it possible
                    // to ship the payment code before the accounts existed.
                    enabled:
                        usable && (row ? row.enabled : environment.present),
                    mode,
                    credentials,
                    source,
                    paypalRecurringMode: recurringMode(
                        row?.paypalRecurringMode,
                    ),
                },
            ] as const;
        });

        return Object.fromEntries(entries) as Record<GatewayId, GatewayConfig>;
    },
);

export async function gatewayConfig<Id extends GatewayId>(
    id: Id,
): Promise<GatewayConfig<Id>> {
    const configs = await loadGatewayConfigs();

    return configs[id] as GatewayConfig<Id>;
}

export async function gatewayEnabled(id: GatewayId): Promise<boolean> {
    return (await gatewayConfig(id)).enabled;
}

/** PayPal's API base. Never inferred from NODE_ENV — a live key with a
 *  sandbox base fails in a way the error never explains. */
export function paypalBase(mode: GatewayMode): string {
    return mode === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";
}

/** Where a provider sends the browser back. Localhost in development. */
export function appUrl(): string {
    return env.BETTER_AUTH_URL || site.url;
}

export type GatewayUpdate = {
    enabled: boolean;
    mode: GatewayMode;
    paypalRecurringMode?: PayPalRecurringMode;
    /**
     * Omitted leaves what is stored alone, so an operator can flip the switch
     * without re-typing a secret they cannot read back. An explicit `null`
     * clears the row and returns the gateway to the environment.
     */
    credentials?: Credentials[GatewayId] | null;
};

/**
 * Writes one gateway's configuration. Takes an executor so the caller can put
 * it in the same transaction as its audit entry.
 */
export async function saveGatewayConfig(
    executor: Pick<typeof db, "insert">,
    id: GatewayId,
    update: GatewayUpdate,
): Promise<void> {
    const blob =
        update.credentials === undefined
            ? undefined
            : update.credentials === null
              ? null
              : encrypt(JSON.stringify(update.credentials), CONTEXT(id));

    await executor
        .insert(schema.paymentGatewaySetting)
        .values({
            id,
            enabled: update.enabled,
            mode: update.mode,
            credentials: blob ?? null,
            paypalRecurringMode: update.paypalRecurringMode ?? null,
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: schema.paymentGatewaySetting.id,
            set: {
                enabled: update.enabled,
                mode: update.mode,
                ...(blob === undefined ? {} : { credentials: blob }),
                paypalRecurringMode: update.paypalRecurringMode ?? null,
                updatedAt: new Date(),
            },
        });
}
