import "server-only";
import { eq, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { formatPrice } from "@/lib/format";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/server/mail";
import { loadSettings, type Settings } from "@/server/settings";
import { taxModeAt } from "@/server/tax/mode";
import {
    claimThresholdNotice,
    type ThresholdMetric,
    thresholdStatus,
} from "./revenue";

/**
 * Telling the operator before the § 19 limit does.
 *
 * Checked after every finalization and every payment rather than on a
 * schedule: there is no job runner until Phase 6, and the figure can only
 * move when one of those two things happens. The work is a pair of sums and
 * an insert that usually conflicts, so it costs nothing to do it then.
 */

type Db = typeof defaultDb;

const METRIC_LABEL = {
    previous: "Vorjahresumsatz",
    current: "Umsatz im laufenden Jahr",
} as const;

/** Staff who are told. Anyone whose roles let them see the invoices. */
async function recipients(db: Db): Promise<string[]> {
    const rows = await db
        .selectDistinct({ email: schema.staffUser.email })
        .from(schema.staffUser)
        .innerJoin(
            schema.staffRoleAssignment,
            eq(schema.staffRoleAssignment.staffUserId, schema.staffUser.id),
        )
        .innerJoin(
            schema.staffRole,
            eq(schema.staffRoleAssignment.roleId, schema.staffRole.id),
        )
        .where(
            sql`${schema.staffRole.permissions} && array['*','billing.*','billing.read']::text[]`,
        );

    return rows.map((row) => row.email);
}

async function sendThresholdMail(
    to: string[],
    entry: ThresholdMetric & { level: 80 | 100 },
) {
    const transport = createTransport();

    if (!transport || to.length === 0) {
        // No relay configured, or nobody to tell. The notice row stays
        // claimed either way — see the caller.
        return;
    }

    const { site } = await loadSettings();
    const label = METRIC_LABEL[entry.metric];
    const percent = Math.floor(entry.ratio * 100);

    const headline =
        entry.level === 100
            ? `§ 19 UStG: Grenze überschritten (${label} ${entry.year})`
            : `§ 19 UStG: ${percent} % der Grenze erreicht (${label} ${entry.year})`;

    const advice =
        entry.level === 100
            ? "Die Kleinunternehmerregelung greift damit nicht mehr unbegrenzt weiter. Bitte sprechen Sie mit der Steuerberatung und planen Sie die Umstellung auf die Regelbesteuerung unter Verwaltung → Einstellungen → Besteuerung."
            : "Das ist noch keine Umstellung, aber der richtige Zeitpunkt, eine zu planen: die Umstellung gilt ab einem Stichtag und wirkt nie rückwirkend.";

    await transport.sendMail({
        from: await mailFrom(),
        to,
        subject: `${headline} — ${site.name}`,
        text: [
            headline,
            "",
            `${label} ${entry.year}: ${formatPrice(entry.netCents)} von ${formatPrice(entry.limitCents)} (${percent} %).`,
            "",
            advice,
            "",
            `${site.url}/admin/settings/tax`,
        ].join("\n"),
        html: await renderEmail({
            preheader: `${label} ${entry.year}: ${formatPrice(entry.netCents)} von ${formatPrice(entry.limitCents)}.`,
            heading: headline,
            intro: [advice],
            action: {
                label: "Besteuerung ansehen",
                url: `${site.url}/admin/settings/tax`,
            },
            rowsTitle: "Stand",
            rows: [
                { label: "Kennzahl", value: `${label} ${entry.year}` },
                { label: "Umsatz (netto)", value: formatPrice(entry.netCents) },
                { label: "Grenze", value: formatPrice(entry.limitCents) },
                { label: "Ausschöpfung", value: `${percent} %` },
            ],
        }),
    });
}

/**
 * Checks the thresholds and sends at most one mail per year, metric and
 * level. Never throws: a warning that cannot be sent must not roll back the
 * invoice that triggered the check.
 */
export async function notifyThresholds(
    db: Db,
    at = new Date(),
    /** Passed in by the tests; loaded from the settings row otherwise. */
    override?: Settings,
) {
    try {
        const settings = override ?? (await loadSettings());

        // The § 19 limits say nothing once the operator is on regular VAT.
        if ((await taxModeAt(db, at)).strategy !== "kleinunternehmer") {
            return;
        }

        const status = await thresholdStatus(db, settings, at);
        const to = await recipients(db);

        for (const entry of [status.previous, status.current]) {
            if (entry.level === null) {
                continue;
            }

            const claimed = await claimThresholdNotice(db, {
                ...entry,
                level: entry.level,
            });

            if (!claimed) {
                continue;
            }

            try {
                await sendThresholdMail(to, { ...entry, level: entry.level });
            } catch (error) {
                // Give the warning back, so the next finalization tries again
                // rather than the operator never hearing about it.
                await db.delete(schema.revenueNotice).where(
                    sql`${schema.revenueNotice.year} = ${entry.year}
                            and ${schema.revenueNotice.metric} = ${entry.metric}
                            and ${schema.revenueNotice.level} = ${entry.level}`,
                );

                logMailError("§ 19 threshold warning", error);
            }
        }
    } catch (error) {
        console.error("[revenue] threshold check failed:", error);
    }
}
