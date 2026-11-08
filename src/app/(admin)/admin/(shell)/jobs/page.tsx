import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { formatDate } from "@/lib/format";
import {
    currentStaffCan,
    requirePermission,
} from "@/server/auth/staff-session";
import { billingRunThrew } from "@/server/billing/run";
import {
    type BillingRunRow,
    jobsOverview,
    recentBillingRuns,
} from "@/server/jobs/status";
import RunBillingButton from "../subscriptions/run-billing-button";

/**
 * What the machinery did while nobody was watching.
 *
 * Two halves, and the split is deliberate. The **Abrechnungsläufe** come
 * from this application's own `billing_run` table and are the thing an
 * operator actually wants to know about — what was invoiced, what was
 * collected, what was dunned, and what failed. The **Warteschlangen** come
 * from pg-boss and say whether the worker is alive at all.
 *
 * A deployment that has never started a worker has no `pgboss` schema, and
 * this page has to be able to *say* that rather than crash on it: "der
 * Worker läuft nicht" is the single most useful sentence it can print.
 */

const RUN_STATUS_LABEL = {
    running: "läuft",
    finished: "fertig",
    failed: "mit Fehlern",
} as const;

const RUN_STATUS_TONE = {
    running: "warning",
    finished: "positive",
    failed: "warning",
} as const;

/**
 * `failed` is two different nights, and only `error` tells them apart: a
 * pass that walked every step and could not bill somebody ("mit Fehlern"),
 * and a pass that threw and did none of the day's work ("abgebrochen"). The
 * second one is retried by the worker; the first one stays done.
 */
function runBadge(run: BillingRunRow): {
    label: string;
    tone: (typeof RUN_STATUS_TONE)[keyof typeof RUN_STATUS_TONE];
} {
    return billingRunThrew(run)
        ? { label: "abgebrochen", tone: "warning" }
        : {
              label: RUN_STATUS_LABEL[run.status],
              tone: RUN_STATUS_TONE[run.status],
          };
}

const STEP_LABEL: Record<string, string> = {
    trialsEnded: "Testphasen beendet",
    trialNoticesSent: "Hinweise auf Testende",
    invoicesIssued: "Rechnungen gestellt",
    invoicedCents: "berechnet (Cent)",
    creditAppliedCents: "Guthaben angerechnet (Cent)",
    collectionsAttempted: "Einzugsversuche",
    collectionsSucceeded: "davon erfolgreich",
    periodsAdvanced: "Zeiträume verlängert",
    subscriptionsPastDue: "Abos überfällig",
    dunningActions: "Mahnschritte",
    servicesSuspended: "Leistungen gesperrt",
    subscriptionsEnded: "Abos beendet",
    couponsExpired: "Gutscheine ausgelaufen",
    reactivated: "wieder aktiviert",
};

export default async function Page() {
    await requirePermission("jobs.read");

    const [overview, runs] = await Promise.all([
        jobsOverview(),
        recentBillingRuns(20),
    ]);

    const mayRun = await currentStaffCan("jobs.manage");

    return (
        <>
            <PageHeader
                title="Aufträge"
                intro="Der tägliche Abrechnungslauf und die Warteschlange dahinter. Der Lauf ist so gebaut, dass er zweimal laufen darf: jeder Schritt reserviert sich seine Zeile, bevor er handelt."
                action={mayRun ? <RunBillingButton /> : undefined}
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Worker</h2>

                    {overview.workerInstalled ? (
                        <>
                            <p className="text-sm text-muted-foreground">
                                Geplant: <code>{overview.expected.name}</code>{" "}
                                um <code>{overview.expected.cron}</code> (
                                {overview.expected.timezone}).
                                {overview.schedules.length === 0
                                    ? " Im Moment ist kein Zeitplan eingetragen — läuft der Worker?"
                                    : ""}
                            </p>

                            {overview.queues.length > 0 ? (
                                <ul className="space-y-2 text-sm">
                                    {overview.queues.map((queue) => (
                                        <li
                                            key={queue.name}
                                            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4"
                                        >
                                            <span className="font-mono text-xs">
                                                {queue.name}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {queue.queued} wartend ·{" "}
                                                {queue.active} laufend ·{" "}
                                                {queue.completed} erledigt ·{" "}
                                                {queue.failed} fehlgeschlagen
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}

                            {overview.failures.length > 0 ? (
                                <div className="space-y-2">
                                    <h3 className="text-xs text-muted-foreground">
                                        Fehlgeschlagene Aufträge
                                    </h3>
                                    <ul className="space-y-2 text-sm">
                                        {overview.failures.map((job) => (
                                            <li
                                                key={job.id}
                                                className="rounded-lg border px-6 py-4"
                                            >
                                                <div className="flex flex-wrap items-center justify-between gap-4">
                                                    <span className="font-mono text-xs">
                                                        {job.name}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatDate(
                                                            job.createdOn,
                                                        )}{" "}
                                                        · {job.retryCount}{" "}
                                                        Versuch(e)
                                                    </span>
                                                </div>
                                                <pre className="mt-2 overflow-x-auto text-xs text-muted-foreground">
                                                    {JSON.stringify(
                                                        job.output,
                                                        null,
                                                        1,
                                                    )}
                                                </pre>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="text-xs text-muted-foreground">
                                        Ein fehlgeschlagener Lauf wird nicht von
                                        Hand wiederholt — „Jetzt abrechnen“ ist
                                        die Wiederholung, und sie ist gefahrlos:
                                        jeder Schritt, der schon erledigt war,
                                        findet seine Zeile vergeben und tut
                                        nichts.
                                    </p>
                                </div>
                            ) : null}
                        </>
                    ) : (
                        <div className="rounded-lg border border-amber-500/40 p-4 text-sm">
                            <p>
                                Es läuft kein Worker: das Schema{" "}
                                <code>pgboss</code> gibt es in dieser Datenbank
                                nicht.
                            </p>
                            <p className="mt-2 text-muted-foreground">
                                Ohne ihn wird nichts automatisch abgerechnet,
                                eingezogen oder gemahnt. Starte ihn mit{" "}
                                <code>npm run worker</code> — oder als eigener
                                Container neben der Anwendung. „Jetzt abrechnen“
                                funktioniert auch ohne ihn, es muss dann nur
                                jemand drücken.
                            </p>
                        </div>
                    )}
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Abrechnungsläufe</h2>

                    {runs.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Noch kein Lauf.
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {runs.map((run) => {
                                const report = run.report ?? {};
                                const badge = runBadge(run);
                                const numbers = Object.entries(report).filter(
                                    ([key, value]) =>
                                        typeof value === "number" &&
                                        value !== 0 &&
                                        key in STEP_LABEL,
                                );

                                return (
                                    <li
                                        key={run.id}
                                        className="rounded-lg border px-6 py-4"
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-4">
                                            <span>
                                                <span className="font-mono text-sm">
                                                    {run.runDay}
                                                </span>
                                                <span className="block text-xs text-muted-foreground">
                                                    {formatDate(run.startedAt)}
                                                    {run.finishedAt
                                                        ? ` · ${Math.max(
                                                              Math.round(
                                                                  (run.finishedAt.getTime() -
                                                                      run.startedAt.getTime()) /
                                                                      1000,
                                                              ),
                                                              0,
                                                          )} s`
                                                        : " · läuft noch"}
                                                    {run.forced
                                                        ? ` · von Hand ausgelöst (${run.forced})`
                                                        : ""}
                                                </span>
                                            </span>
                                            <StatusBadge
                                                label={badge.label}
                                                tone={badge.tone}
                                            />
                                        </div>

                                        {numbers.length > 0 ? (
                                            <dl className="mt-3 grid gap-x-8 gap-y-1 border-t pt-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                                                {numbers.map(([key, value]) => (
                                                    <div
                                                        key={key}
                                                        className="flex justify-between gap-4"
                                                    >
                                                        <dt className="text-muted-foreground">
                                                            {STEP_LABEL[key]}
                                                        </dt>
                                                        <dd className="font-mono">
                                                            {String(value)}
                                                        </dd>
                                                    </div>
                                                ))}
                                            </dl>
                                        ) : null}

                                        {run.report?.failures?.length ? (
                                            <ul className="mt-3 space-y-1 border-t pt-3 text-xs text-destructive">
                                                {run.report.failures.map(
                                                    (failure) => (
                                                        <li
                                                            key={`${failure.step}:${failure.entityId}`}
                                                        >
                                                            {failure.step} ·{" "}
                                                            {failure.entityId}:{" "}
                                                            {failure.message}
                                                        </li>
                                                    ),
                                                )}
                                            </ul>
                                        ) : null}

                                        {run.error ? (
                                            <p className="mt-3 border-t pt-3 text-xs text-destructive">
                                                {run.error}
                                            </p>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </>
    );
}
