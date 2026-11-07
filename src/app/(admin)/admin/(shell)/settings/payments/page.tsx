import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { requirePermission } from "@/server/auth/staff-session";
import { loadGatewayConfigs } from "@/server/payments/settings";
import { loadSettings } from "@/server/settings";
import GatewayForm from "./gateway-form";

export const dynamic = "force-dynamic";

/**
 * Which ways of paying are offered, and what they are configured with.
 *
 * The credentials are encrypted at rest (hard rule 6) and write-only: this
 * page can say that something is stored, never what. The environment stays
 * the fallback, so a developer with keys in `.env.local` needs no row here
 * and a deployment can move to this page without migrating its secrets.
 */
export default async function Page() {
    await requirePermission("settings.write");

    const gateways = await loadGatewayConfigs();
    const settings = await loadSettings();

    return (
        <>
            <PageHeader
                title="Zahlungsarten"
                intro="Was im Kundenbereich angeboten wird, und womit es sich beim Anbieter anmeldet. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <div className="mb-6 flex items-center gap-3">
                    <h2 className="font-medium text-sm tracking-tight">
                        Kreditkarte (Stripe)
                    </h2>
                    <StatusBadge
                        label={
                            gateways.stripe.enabled
                                ? `Aktiv · ${gateways.stripe.mode === "live" ? "Live" : "Sandbox"}`
                                : "Aus"
                        }
                        tone={gateways.stripe.enabled ? "positive" : "muted"}
                    />
                </div>

                <GatewayForm
                    id="stripe"
                    label="Kreditkarte"
                    enabled={gateways.stripe.enabled}
                    mode={gateways.stripe.mode}
                    source={gateways.stripe.source}
                    // Stripe says which world a key belongs to in the key
                    // itself, so there is nothing to pick and nothing to get
                    // wrong.
                    showMode={false}
                    secrets={[
                        {
                            name: "secretKey",
                            label: "Secret Key",
                            present: Boolean(
                                (
                                    gateways.stripe
                                        .credentials as Record<string, string>
                                ).secretKey,
                            ),
                            help: "sk_test_… oder sk_live_… — das Präfix entscheidet über Sandbox oder Live.",
                        },
                        {
                            name: "webhookSecret",
                            label: "Webhook Signing Secret",
                            present: Boolean(
                                (
                                    gateways.stripe
                                        .credentials as Record<string, string>
                                ).webhookSecret,
                            ),
                            help: `whsec_… für den Endpunkt ${settings.site.url}/api/webhooks/stripe`,
                        },
                    ]}
                />
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <div className="mb-6 flex items-center gap-3">
                    <h2 className="font-medium text-sm tracking-tight">
                        PayPal
                    </h2>
                    <StatusBadge
                        label={
                            gateways.paypal.enabled
                                ? `Aktiv · ${gateways.paypal.mode === "live" ? "Live" : "Sandbox"}`
                                : "Aus"
                        }
                        tone={gateways.paypal.enabled ? "positive" : "muted"}
                    />
                </div>

                <GatewayForm
                    id="paypal"
                    label="PayPal"
                    enabled={gateways.paypal.enabled}
                    mode={gateways.paypal.mode}
                    source={gateways.paypal.source}
                    paypalRecurringMode={gateways.paypal.paypalRecurringMode}
                    secrets={[
                        {
                            name: "clientId",
                            label: "Client ID",
                            present: Boolean(
                                (
                                    gateways.paypal
                                        .credentials as Record<string, string>
                                ).clientId,
                            ),
                        },
                        {
                            name: "clientSecret",
                            label: "Client Secret",
                            present: Boolean(
                                (
                                    gateways.paypal
                                        .credentials as Record<string, string>
                                ).clientSecret,
                            ),
                        },
                        {
                            name: "webhookId",
                            label: "Webhook ID",
                            present: Boolean(
                                (
                                    gateways.paypal
                                        .credentials as Record<string, string>
                                ).webhookId,
                            ),
                            help: `Aus dem PayPal-Dashboard, für den Endpunkt ${settings.site.url}/api/webhooks/paypal. Ohne ihn lässt sich kein Ereignis prüfen.`,
                        },
                    ]}
                />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <div className="mb-6 flex items-center gap-3">
                    <h2 className="font-medium text-sm tracking-tight">
                        Überweisung
                    </h2>
                    <StatusBadge
                        label={
                            gateways.banktransfer.enabled ? "Aktiv" : "Aus"
                        }
                        tone={
                            gateways.banktransfer.enabled
                                ? "positive"
                                : "muted"
                        }
                    />
                </div>

                <p className="mb-6 max-w-2xl text-muted-foreground text-sm leading-7">
                    Die Bankverbindung steht in den{" "}
                    <span className="text-foreground">Einstellungen</span> und
                    auf jeder Rechnung — sie ist kein Geheimnis und wird hier
                    nicht noch einmal gepflegt. Der Kunde bekommt sie samt
                    GiroCode auf der Rechnung angezeigt; der Eingang wird unter{" "}
                    <span className="text-foreground">Zahlungen</span> von Hand
                    verbucht.
                </p>

                <GatewayForm
                    id="banktransfer"
                    label="Überweisung"
                    enabled={gateways.banktransfer.enabled}
                    mode={gateways.banktransfer.mode}
                    source={gateways.banktransfer.source}
                    showMode={false}
                    secrets={[]}
                />
            </div>
        </>
    );
}
