import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";

/**
 * What an employee, or an API key, is allowed to do.
 *
 * The strings are a catalogue in code rather than rows in a table: a role
 * stores the ones it grants, but what may be granted is fixed by the
 * application, so `requirePermission("billng.write")` is a type error instead
 * of a check that silently never passes.
 */
export const PERMISSIONS = {
    "customers.read": "Kundenkonten und Kontakte ansehen",
    "customers.write": "Kundenkonten anlegen und Stammdaten ändern",
    "billing.read": "Rechnungen und Korrekturen ansehen",
    "billing.write": "Rechnungen anlegen, stellen und stornieren",
    "offers.read": "Angebote ansehen",
    "offers.write": "Angebote anlegen, senden und zurückziehen",
    "contracts.read": "Verträge ansehen",
    "contracts.write": "Verträge anlegen und ändern",
    "orders.read": "Bestellungen ansehen",
    "orders.write":
        "Bestellungen aufgeben, annehmen, stornieren und als Betrug markieren",
    "subscriptions.read": "Abos ansehen",
    "subscriptions.write":
        "Abos kündigen, pausieren, fortsetzen und Tarife wechseln",
    "services.read": "Leistungen und ihre Zugangsdaten ansehen",
    "services.write":
        "Leistungen einrichten, sperren, abbauen und Energieaktionen auslösen",
    "services.manage":
        "Bereitstellungsserver, IP-Pools und PTR-Einträge verwalten",
    "jobs.read": "Hintergrundaufträge und Abrechnungsläufe ansehen",
    "jobs.manage": "Abrechnungsläufe auslösen und Aufträge wiederholen",
    "catalog.read": "Produkte, Optionen und Gutscheine ansehen",
    "catalog.write":
        "Produkte, Preise, Optionen und Gutscheine anlegen und ändern",
    "payments.read": "Zahlungen und Zahlungsmittel ansehen",
    "payments.write": "Zahlungen erfassen und erstatten",
    "tickets.read": "Tickets ansehen",
    "tickets.reply": "Auf Tickets antworten",
    "tickets.write": "Tickets anlegen, zuweisen, zusammenführen und schließen",
    "tickets.manage":
        "Abteilungen, Postfach-Anbindung und Textbausteine verwalten",
    "legal.write": "Rechtstexte bearbeiten und veröffentlichen",
    "settings.write": "Einstellungen des Portals ändern",
    "staff.manage": "Mitarbeiter einladen und entfernen",
    "roles.manage": "Rollen und Berechtigungen vergeben",
    "apikeys.manage": "API-Schlüssel der Verwaltung erzeugen und widerrufen",
    "audit.read": "Das Protokoll lesen",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Grants everything there is, now and in every later phase. */
export const WILDCARD = "*";

export const SUPER_ADMIN_ROLE = "Super Admin";

/**
 * Whether `granted` covers `needed`.
 *
 * Three forms are accepted: the permission itself, `domain.*` for everything
 * in one domain, and `*` for everything. A domain wildcard is what makes a
 * role survive a later phase adding `tickets.close` — the alternative is a
 * role that silently stops covering its own area.
 */
export function hasPermission(
    granted: readonly string[],
    needed: Permission,
): boolean {
    if (granted.includes(WILDCARD) || granted.includes(needed)) {
        return true;
    }

    const domain = needed.slice(0, needed.indexOf("."));

    return granted.includes(`${domain}.${WILDCARD}`);
}

/** Thrown rather than returned, so a forgotten check cannot read as success. */
export class PermissionDeniedError extends Error {
    constructor(readonly permission: Permission) {
        super(`Permission denied: ${permission}`);
        this.name = "PermissionDeniedError";
    }
}

type Db = Pick<typeof defaultDb, "select">;

/**
 * Everything the employee's roles grant, flattened. An employee with no role
 * gets an empty list and can therefore do nothing — which is the right
 * default for an invitation that has been accepted but not yet given a job.
 */
export async function permissionsForStaff(
    db: Db,
    staffUserId: string,
): Promise<string[]> {
    const rows = await db
        .select({ permissions: schema.staffRole.permissions })
        .from(schema.staffRoleAssignment)
        .innerJoin(
            schema.staffRole,
            eq(schema.staffRoleAssignment.roleId, schema.staffRole.id),
        )
        .where(eq(schema.staffRoleAssignment.staffUserId, staffUserId));

    return [...new Set(rows.flatMap((row) => row.permissions))];
}

export async function staffCan(
    db: Db,
    staffUserId: string,
    needed: Permission,
): Promise<boolean> {
    return hasPermission(await permissionsForStaff(db, staffUserId), needed);
}

/** The guard the services use. Throws; it never returns false. */
export async function assertStaffPermission(
    db: Db,
    staffUserId: string,
    needed: Permission,
): Promise<void> {
    if (!(await staffCan(db, staffUserId, needed))) {
        throw new PermissionDeniedError(needed);
    }
}
