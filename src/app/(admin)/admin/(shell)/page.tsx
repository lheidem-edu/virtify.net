import { sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db, schema } from "@/db";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";
import { formatDate, formatPrice } from "@/lib/format";
import { currentStaffCan, requireStaff } from "@/server/auth/staff-session";
import { thresholdStatus } from "@/server/billing/revenue";
import { loadSettings, REVENUE_BASIS_LABEL } from "@/server/settings";
import { TAX_STRATEGY_LABEL } from "@/server/tax";
import { taxModeAt } from "@/server/tax/mode";

export const dynamic = "force-dynamic";

const CARD = "rounded-lg border p-6";
const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

/**
 * The operator's first screen. Deliberately small: what needs attention
 * today, and the one figure that cannot be noticed too late — the § 19
 * threshold, which ends the Kleinunternehmerregelung the moment it is
 * passed rather than at the end of the year.
 */
export default async function Page() {
    await requireStaff();

    const canBilling = await currentStaffCan("billing.read");

    if (!canBilling) {
        // Nothing on this page is readable without it; the customer list is
        // where an employee without billing rights starts.
        redirect("/admin/customers");
    }

    const now = new Date();
    const settings = await loadSettings();

    const [threshold, mode, counts] = await Promise.all([
        thresholdStatus(db, settings, now),
        taxModeAt(db, now),
        db
            .select({
                status: schema.invoice.status,
                count: sql<number>`count(*)::int`,
                amount: sql<number>`coalesce(sum(${schema.invoice.grossCents}), 0)::int`,
            })
            .from(schema.invoice)
            .groupBy(schema.invoice.status),
    ]);

    const by = (status: string) =>
        counts.find((row) => row.status === status) ?? {
            count: 0,
            amount: 0,
        };

    const drafts = by("draft");

    // "Offen" is both open statuses: a part-paid invoice still wants money,
    // and leaving it out would make the figure on the overview smaller than
    // what is actually outstanding.
    const unpaid = OPEN_INVOICE_STATUSES.map(by).reduce(
        (sum, row) => ({
            count: sum.count + row.count,
            amount: sum.amount + row.amount,
        }),
        { count: 0, amount: 0 },
    );

    const warn = threshold.level !== null;
    const isSmallBusiness = mode.strategy === "kleinunternehmer";

    return (
        <>
            <PageHeader
                title="Übersicht"
                intro="Was heute ansteht, und die Zahl, die man nicht zu spät sehen darf."
                action={
                    <StatusBadge
                        label={TAX_STRATEGY_LABEL[mode.strategy]}
                        tone={isSmallBusiness ? "neutral" : "positive"}
                    />
                }
            />

            <div className="grid gap-6 px-6 py-10 md:grid-cols-2 md:px-10 md:py-12">
                <div className={CARD}>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">
                        Offene Rechnungen
                    </p>
                    <p className="mt-2 font-mono text-2xl">
                        {formatPrice(unpaid.amount)}
                    </p>
                    <p className="mt-1 text-muted-foreground text-sm">
                        {unpaid.count} Stück ·{" "}
                        <Link href="/admin/invoices" className={LINK}>
                            ansehen
                        </Link>
                    </p>
                </div>

                <div className={CARD}>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">
                        Entwürfe
                    </p>
                    <p className="mt-2 font-mono text-2xl">{drafts.count}</p>
                    <p className="mt-1 text-muted-foreground text-sm">
                        noch ohne Nummer ·{" "}
                        <Link href="/admin/invoices" className={LINK}>
                            ansehen
                        </Link>
                    </p>
                </div>

                {isSmallBusiness ? (
                    <div
                        className={`${CARD} md:col-span-2 ${
                            warn ? "border-amber-500/50" : ""
                        }`}
                    >
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <h2 className="font-medium text-sm tracking-tight">
                                § 19 UStG — Umsatzgrenzen
                            </h2>
                            {warn ? (
                                <StatusBadge
                                    label={
                                        threshold.level === 100
                                            ? "Grenze überschritten"
                                            : "80 % erreicht"
                                    }
                                    tone="warning"
                                />
                            ) : null}
                        </div>

                        <dl className="mt-6 grid gap-6 sm:grid-cols-2">
                            {[threshold.previous, threshold.current].map(
                                (entry) => (
                                    <div key={entry.metric}>
                                        <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                                            {entry.metric === "previous"
                                                ? "Vorjahr"
                                                : "Laufendes Jahr"}{" "}
                                            {entry.year}
                                        </dt>
                                        <dd className="mt-2 font-mono text-lg">
                                            {formatPrice(entry.netCents)}
                                        </dd>
                                        <dd className="mt-2">
                                            {/* A bar rather than a number
                                                alone: 62 % of a limit is a
                                                feeling, not an amount. */}
                                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                                <div
                                                    className={
                                                        entry.ratio >= 1
                                                            ? "h-full bg-red-500"
                                                            : entry.ratio >= 0.8
                                                              ? "h-full bg-amber-500"
                                                              : "h-full bg-emerald-500"
                                                    }
                                                    style={{
                                                        width: `${Math.min(entry.ratio, 1) * 100}%`,
                                                    }}
                                                />
                                            </div>
                                        </dd>
                                        <dd className="mt-1 text-muted-foreground text-xs">
                                            von {formatPrice(entry.limitCents)}{" "}
                                            — {Math.floor(entry.ratio * 100)} %
                                        </dd>
                                    </div>
                                ),
                            )}
                        </dl>

                        <p className="mt-6 text-muted-foreground text-xs">
                            Nettoumsatz bezahlter Rechnungen abzüglich
                            Korrekturen, zugeordnet nach{" "}
                            {REVENUE_BASIS_LABEL[settings.revenue.basis]}.{" "}
                            <Link href="/admin/settings/tax" className={LINK}>
                                Besteuerung verwalten
                            </Link>
                        </p>
                    </div>
                ) : (
                    <div className={`${CARD} md:col-span-2`}>
                        <h2 className="font-medium text-sm tracking-tight">
                            Regelbesteuerung
                        </h2>
                        <p className="mt-2 text-muted-foreground text-sm">
                            Seit {formatDate(mode.effectiveFrom)} werden
                            Rechnungen mit Umsatzsteuer ausgestellt. Die §
                            19-Grenzen spielen keine Rolle mehr.{" "}
                            <Link href="/admin/settings/tax" className={LINK}>
                                Besteuerung ansehen
                            </Link>
                        </p>
                    </div>
                )}
            </div>
        </>
    );
}
