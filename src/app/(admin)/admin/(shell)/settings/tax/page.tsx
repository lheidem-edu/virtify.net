import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import { formatDate, formatPrice } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { thresholdStatus } from "@/server/billing/revenue";
import { loadSettings, REVENUE_BASIS_LABEL } from "@/server/settings";
import {
    standardRates,
    TAX_STRATEGY_DESCRIPTION,
    TAX_STRATEGY_IDS,
    TAX_STRATEGY_LABEL,
} from "@/server/tax";
import { listTaxModes, taxModeAt } from "@/server/tax/mode";
import { CancelTaxSwitchForm, TaxSwitchForm } from "./tax-switch-form";

export const dynamic = "force-dynamic";

/**
 * Which tax strategy is in force, since when, and what is scheduled.
 *
 * The page exists because switching is a decision with a date, not a toggle:
 * the resolver picks the strategy by the moment a document is finalized, so a
 * row here is the only thing that ever changes what an invoice says — and
 * never what an invoice already said.
 */
export default async function Page() {
    await requirePermission("settings.write");

    const now = new Date();
    const settings = await loadSettings();

    const [history, active, threshold] = await Promise.all([
        listTaxModes(db),
        taxModeAt(db, now),
        thresholdStatus(db, settings, now),
    ]);

    const scheduled = history.filter(
        (entry) => entry.effectiveFrom.getTime() > now.getTime(),
    );
    const applied = history
        .filter((entry) => entry.effectiveFrom.getTime() <= now.getTime())
        .reverse();

    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
    }).format(now);

    const rates = standardRates(now);

    return (
        <>
            <PageHeader
                title="Besteuerung"
                intro="Welche Besteuerung gilt, seit wann, und was geplant ist. Maßgeblich ist immer das Ausstellungsdatum der Rechnung."
                action={
                    <StatusBadge
                        label={TAX_STRATEGY_LABEL[active.strategy]}
                        tone={
                            active.strategy === "kleinunternehmer"
                                ? "neutral"
                                : "positive"
                        }
                    />
                }
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-2 font-medium text-sm tracking-tight">
                    Aktuell: {TAX_STRATEGY_LABEL[active.strategy]}
                </h2>
                <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                    {TAX_STRATEGY_DESCRIPTION[active.strategy]}
                </p>
                <p className="mt-2 text-muted-foreground text-xs">
                    {active.effectiveFrom
                        ? `Gilt seit ${formatDate(active.effectiveFrom)}.`
                        : "Voreinstellung — es wurde nie etwas anderes eingestellt."}
                </p>

                <div className="mt-8">
                    <TaxSwitchForm
                        current={active.strategy}
                        today={today}
                        strategies={TAX_STRATEGY_IDS.map((id) => ({
                            id,
                            label: TAX_STRATEGY_LABEL[id],
                            description: TAX_STRATEGY_DESCRIPTION[id],
                        }))}
                    />
                </div>
            </div>

            {scheduled.length > 0 ? (
                <div className="border-b px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 font-medium text-sm tracking-tight">
                        Geplant
                    </h2>
                    <div className="max-w-3xl space-y-4">
                        {scheduled.map((entry) => (
                            <div
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
                            >
                                <div>
                                    <p className="text-sm">
                                        {TAX_STRATEGY_LABEL[
                                            entry.strategy as keyof typeof TAX_STRATEGY_LABEL
                                        ] ?? entry.strategy}{" "}
                                        ab {formatDate(entry.effectiveFrom)}
                                    </p>
                                    {entry.note ? (
                                        <p className="mt-1 text-muted-foreground text-xs">
                                            {entry.note}
                                        </p>
                                    ) : null}
                                </div>
                                <CancelTaxSwitchForm
                                    id={entry.id}
                                    label={
                                        TAX_STRATEGY_LABEL[
                                            entry.strategy as keyof typeof TAX_STRATEGY_LABEL
                                        ] ?? entry.strategy
                                    }
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Verlauf
                </h2>
                <div className="max-w-3xl overflow-x-auto rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Gültig ab</TableHead>
                                <TableHead>Besteuerung</TableHead>
                                <TableHead>Notiz</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {applied.map((entry) => (
                                <TableRow key={entry.id}>
                                    <TableCell>
                                        {formatDate(entry.effectiveFrom)}
                                    </TableCell>
                                    <TableCell>
                                        {TAX_STRATEGY_LABEL[
                                            entry.strategy as keyof typeof TAX_STRATEGY_LABEL
                                        ] ?? entry.strategy}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {entry.note ?? "—"}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-2 font-medium text-sm tracking-tight">
                    § 19 UStG — Umsatzgrenzen
                </h2>
                <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                    Gezählt wird der Nettoumsatz bezahlter Rechnungen abzüglich
                    der Korrekturen, zugeordnet nach{" "}
                    {REVENUE_BASIS_LABEL[settings.revenue.basis]}.
                </p>

                <dl className="mt-8 grid max-w-3xl gap-6 sm:grid-cols-2">
                    {[threshold.previous, threshold.current].map((entry) => (
                        <div
                            key={entry.metric}
                            className="rounded-lg border p-5"
                        >
                            <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                                {entry.metric === "previous"
                                    ? "Vorjahr"
                                    : "Laufendes Jahr"}{" "}
                                {entry.year}
                            </dt>
                            <dd className="mt-2 font-mono text-lg">
                                {formatPrice(entry.netCents)}
                            </dd>
                            <dd className="mt-1 text-muted-foreground text-xs">
                                von {formatPrice(entry.limitCents)} —{" "}
                                {Math.floor(entry.ratio * 100)} %
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-2 font-medium text-sm tracking-tight">
                    Regelsteuersätze in der EU
                </h2>
                <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                    Die Sätze, die bei Regelbesteuerung für Privatkunden im
                    jeweiligen Bestimmungsland über das One-Stop-Shop-Verfahren
                    gelten. Stand {formatDate(now)}.
                </p>
                <ul className="mt-6 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
                    {rates.map((rate) => (
                        <li
                            key={rate.country}
                            className="flex justify-between font-mono text-xs"
                        >
                            <span>{rate.country}</span>
                            <span className="text-muted-foreground">
                                {(rate.rateBp / 100)
                                    .toLocaleString("de-DE", {
                                        maximumFractionDigits: 2,
                                    })
                                    .concat(" %")}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </>
    );
}
