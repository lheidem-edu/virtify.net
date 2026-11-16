import { Download } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import PageHeader from "@/components/shared/page-header";
import { getCurrentCustomer } from "@/server/customers/current";

/**
 * „Meine Daten" — the customer's own copy, and what cannot be deleted.
 *
 * The deletion paragraph is the honest half of this page and it is there
 * rather than hidden behind a support request: invoices are kept because
 * § 147 AO and § 14b UStG require it for ten years and Art. 17 Abs. 3 lit. b
 * DSGVO exempts exactly that, and somebody asking to be forgotten deserves to
 * read why the answer is "the rest of it, yes".
 */
export default async function Page() {
    // The guard is the page's whole access control: no id reaches this route
    // and none could.
    await getCurrentCustomer();

    const t = await getTranslations("portal.privacy");

    return (
        <>
            <PageHeader title={t("title")} />

            <div className="max-w-3xl space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <p className="text-sm leading-7 text-muted-foreground">
                        {t("intro")}
                    </p>

                    <Link
                        href="/client/privacy/export"
                        prefetch={false}
                        className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors hover:border-ring"
                    >
                        <Download className="size-4" />
                        {t("action")}
                    </Link>

                    <p className="text-xs leading-6 text-muted-foreground">
                        {t("note")}
                    </p>
                </section>

                <section className="space-y-3">
                    <h2 className="text-sm font-medium">{t("deletion")}</h2>
                    <p className="text-sm leading-7 text-muted-foreground">
                        {t("deletionIntro")}
                    </p>
                </section>
            </div>
        </>
    );
}
