import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import { requirePermission } from "@/server/auth/staff-session";
import { loadSettings } from "@/server/settings";
import SettingsForm from "./settings-form";

export default async function Page() {
    await requirePermission("settings.write");

    const { site, operator, bank, policy } = await loadSettings();

    return (
        <>
            <PageHeader
                title="Einstellungen"
                intro="Deine eigenen Angaben. Sie stehen im Impressum, auf jeder Rechnung, in jeder Mail und in den Rechtstexten — dort als Platzhalter, damit sie nicht doppelt gepflegt werden müssen."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-2 font-medium text-sm tracking-tight">
                    Besteuerung
                </h2>
                <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                    Welche Besteuerung gilt und ab wann — und wie weit die
                    Umsatzgrenzen des § 19 UStG ausgeschöpft sind. Eine
                    Umstellung gilt ab einem Stichtag und nie rückwirkend, also
                    liegt sie auf einer eigenen Seite.
                </p>
                <Link
                    href="/admin/settings/tax"
                    className="mt-4 inline-block text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    Besteuerung verwalten
                </Link>
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <SettingsForm
                    values={{
                        siteName: site.name,
                        siteUrl: site.url,
                        tagline: site.tagline,
                        description: site.description,
                        operatorName: operator.name,
                        operatorStreet: operator.street,
                        operatorCity: operator.city,
                        operatorCountry: operator.country,
                        operatorEmail: operator.email,
                        operatorVatId: operator.vatId,
                        operatorTaxNumber: operator.taxNumber,
                        operatorPhone: operator.phone,
                        bankName: bank.name,
                        bankIban: bank.iban,
                        bankBic: bank.bic,
                        logRetentionDays: policy.logRetentionDays,
                        paymentTermDays: policy.paymentTermDays,
                        dataRetrievalDays: policy.dataRetrievalDays,
                        securityMaintenanceNoticeHours:
                            policy.securityMaintenanceNoticeHours,
                    }}
                />
            </div>
        </>
    );
}
