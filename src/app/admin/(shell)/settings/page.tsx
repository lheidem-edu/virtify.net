import PageHeader from "@/lib/components/account/page-header";
import { loadSettings } from "@/lib/settings";
import { requireStaff } from "@/lib/staff-session";
import SettingsForm from "./settings-form";

export default async function Page() {
    await requireStaff();

    const { site, operator, bank, policy } = await loadSettings();

    return (
        <>
            <PageHeader
                title="Einstellungen"
                intro="Deine eigenen Angaben. Sie stehen im Impressum, auf jeder Rechnung, in jeder Mail und in den Rechtstexten — dort als Platzhalter, damit sie nicht doppelt gepflegt werden müssen."
            />

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
