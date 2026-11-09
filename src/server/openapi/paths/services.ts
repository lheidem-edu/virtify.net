import { zId } from "@/lib/ulid";
import { SERVICE_ACTIONS } from "@/server/provisioning/actions";
import { apiKeyAuth, registry, z } from "../registry";
import { cursorPage, PROBLEM_RESPONSES, ProblemSchema } from "../schemas";

/**
 * `/api/v1/services` — the three endpoints of Phase 8.
 *
 * Rule 11: an endpoint that is not described here is not done. Summary,
 * description, tag, schemas with per-field descriptions and examples, the
 * error shapes and the authentication each one needs.
 */

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const STATUS = z
    .enum(["pending", "provisioning", "active", "suspended", "terminated"])
    .openapi({
        description:
            "Der **Stand der Leistung in der Abrechnung** — und damit das, " +
            "was gilt. `pending` ist bestellt und noch nicht eingerichtet, " +
            "`provisioning` wird gerade angelegt, `active` läuft, " +
            "`suspended` ist gesperrt (offene Rechnung oder pausiertes Abo), " +
            "`terminated` ist abgebaut.",
        example: "active",
    });

const PROVIDER_STATUS = z
    .enum(["running", "stopped", "suspended", "unknown", "missing"])
    .openapi({
        description:
            "Was die Virtualisierung beim letzten Abruf gemeldet hat. " +
            "Dies ist eine **Beobachtung, kein Zustand**: bei einem " +
            "Widerspruch gilt immer `status`, und `mismatch` beschreibt ihn " +
            "in Worten. `missing` heißt, dass auf dem Server keine Maschine " +
            "mehr zu finden war.",
        example: "running",
    });

const AddressSchema = registry.register(
    "ServiceAddress",
    z
        .object({
            id: zId("ipaddress").openapi({
                description: "Technische ID der Adresszuweisung.",
            }),
            family: z.enum(["ipv4", "ipv6"]).openapi({
                description: "Adressfamilie.",
                example: "ipv4",
            }),
            address: z.string().openapi({
                description: "Die Adresse selbst.",
                example: "192.0.2.17",
            }),
            prefix_length: z.int().openapi({
                description: "Die Maske in Bit, aus dem Pool.",
                example: 24,
            }),
            gateway: z.string().nullable().openapi({
                description: "Das Gateway des Pools.",
                example: "192.0.2.1",
            }),
            nameservers: z.array(z.string()).openapi({
                description: "Was der Maschine per cloud-init mitgegeben wird.",
                example: ["9.9.9.9", "149.112.112.112"],
            }),
            rdns: z
                .string()
                .nullable()
                .openapi({
                    description:
                        "Der PTR-Eintrag, den die Verwaltung gesetzt hat. Wird " +
                        "mit der Adresse freigegeben — er benennt einen Host, " +
                        "den es dann nicht mehr gibt.",
                    example: "vps-17.virtify.net",
                }),
        })
        .openapi({
            description:
                "Eine IP-Adresse, solange sie dieser Leistung gehört. Eine " +
                "Adresse wird beim Einrichten aus einem Pool genommen und " +
                "beim Abbau zurückgegeben — und nur dann.",
        }),
);

const ActionSchema = registry.register(
    "ServiceAvailableAction",
    z.object({
        id: z.string().openapi({
            description: "Als `action` an die Aktions-Route zu übergeben.",
            example: "reboot",
        }),
        label: z.string().openapi({
            description: "Beschriftung für eine Schaltfläche.",
            example: "Neu starten",
        }),
        description: z.string().openapi({
            description: "Was die Aktion tut.",
            example: "Fährt das Gastsystem herunter und startet es wieder.",
        }),
        destructive: z.boolean().openapi({
            description:
                "Ob dabei Daten verloren gehen. Solche Aktionen werden nie " +
                "automatisch wiederholt — ein Fehlschlag wird gemeldet, " +
                "nicht nachgeholt.",
            example: false,
        }),
    }),
);

const ServiceRowSchema = registry.register(
    "ServiceListItem",
    z
        .object({
            id: zId("service").openapi({
                description: "Technische ID der Leistung.",
            }),
            label: z.string().openapi({
                description: "Wie die Leistung dem Kunden angezeigt wird.",
                example: "VPS M (1/2)",
            }),
            status: STATUS,
            module: z.string().openapi({
                description:
                    "Das Bereitstellungsmodul. `none`, solange nichts " +
                    "automatisch eingerichtet wird.",
                example: "proxmox",
            }),
            module_label: z.string().openapi({
                description: "Der Name des Moduls, auf Deutsch.",
                example: "Proxmox VE",
            }),
            customer_id: zId("customer").openapi({
                description: "Wem die Leistung gehört.",
            }),
            product_id: zId("product").openapi({
                description: "Das Produkt, das sie beschreibt.",
            }),
            subscription_id: zId("subscription")
                .nullable()
                .openapi({
                    description:
                        "Das Abo, das sie bezahlt. `null` für eine Leistung, die " +
                        "von Hand angelegt wurde.",
                }),
            hostname: z.string().nullable().openapi({
                description: "Der Hostname, der eingerichtet wurde.",
                example: "vps-m-101",
            }),
            primary_address: z.string().nullable().openapi({
                description: "Die erste zugewiesene Adresse, für die Liste.",
                example: "192.0.2.17",
            }),
            provider_status: PROVIDER_STATUS.nullable(),
            provider_status_at: z.iso.datetime().nullable().openapi({
                description: "Wann zuletzt abgefragt wurde, in UTC.",
                example: "2026-11-09T07:05:00.000Z",
            }),
            activated_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie in Betrieb genommen wurde, in UTC.",
                example: "2026-11-01T09:00:00.000Z",
            }),
            suspended_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie gesperrt wurde, in UTC.",
                example: null,
            }),
            terminated_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie abgebaut wurde, in UTC.",
                example: null,
            }),
        })
        .openapi({
            description:
                "Eine bereitgestellte Sache — ein VPS, ein Webspace — eine " +
                "je bestellter Einheit.",
        }),
);

const TaskSchema = registry.register(
    "ServiceTask",
    z
        .object({
            id: zId("provtask").openapi({
                description: "Technische ID der Anfrage.",
            }),
            action: z
                .enum([
                    "create",
                    "suspend",
                    "unsuspend",
                    "terminate",
                    "change_package",
                    "power",
                    "reinstall",
                    "sync",
                ])
                .openapi({
                    description: "Was vom Modul verlangt wurde.",
                    example: "create",
                }),
            request_key: z.string().openapi({
                description:
                    "Wofür genau diese Zeile steht. `create` ist für jede " +
                    "Leistung ein einziges Mal vergeben — deshalb legt ein " +
                    "zweiter Anlauf keine zweite Maschine an.",
                example: "create",
            }),
            status: z
                .enum(["pending", "running", "succeeded", "failed", "aborted"])
                .openapi({
                    description:
                        "`aborted` heißt: abgebrochen, **bevor** die " +
                        "Virtualisierung überhaupt gefragt wurde — dann ist " +
                        "sicher nichts entstanden und alles Belegte wurde " +
                        "zurückgegeben.",
                    example: "succeeded",
                }),
            attempts: z.int().openapi({
                description: "Wie oft es versucht wurde.",
                example: 1,
            }),
            max_attempts: z.int().openapi({
                description:
                    "Wie oft es versucht werden darf. Je Aktion verschieden: " +
                    "fünf für ein Anlegen, das über die reservierte Kennung " +
                    "wiederholbar ist, und genau einer für eine " +
                    "Neuinstallation, die Daten vernichtet.",
                example: 5,
            }),
            provider_called_at: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Wann zum ersten Mal etwas verlangt wurde, das auf der " +
                        "Virtualisierung etwas ändern kann. Solange dies `null` " +
                        "ist, kann dort nichts entstanden sein.",
                    example: "2026-11-01T09:00:03.000Z",
                }),
            last_error: z.string().nullable().openapi({
                description: "Was zuletzt schiefging.",
                example: null,
            }),
            requested_by: z.string().nullable().openapi({
                description: "Wer sie ausgelöst hat.",
                example: "staff:Luca",
            }),
            created_at: z.iso.datetime().openapi({
                description: "Wann sie eingereiht wurde, in UTC.",
                example: "2026-11-01T09:00:00.000Z",
            }),
            finished_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie fertig wurde, in UTC.",
                example: "2026-11-01T09:02:11.000Z",
            }),
        })
        .openapi({
            description:
                "Ein Aufruf des Moduls. Nur für Schlüssel der Verwaltung.",
        }),
);

const ServiceSchema = registry.register(
    "Service",
    ServiceRowSchema.omit({ primary_address: true })
        .extend({
            subscription_status: z.string().nullable().openapi({
                description: "Der Stand des Abos, das sie bezahlt.",
                example: "active",
            }),
            addresses: z.array(AddressSchema).openapi({
                description: "Die zugewiesenen IP-Adressen.",
            }),
            provider_status_detail: z.string().nullable().openapi({
                description: "Ein Satz zum letzten Abruf.",
                example: "Läuft seit 72 h.",
            }),
            mismatch: z
                .string()
                .nullable()
                .openapi({
                    description:
                        "Gesetzt, wenn Abrechnung und Maschine sich " +
                        "widersprechen — etwa „Die Leistung ist aktiv, die " +
                        "Maschine läuft aber nicht.“ Es ist ein **Hinweis für " +
                        "einen Menschen**: nichts im Panel handelt danach, weil " +
                        "sonst zwei Systeme abwechselnd dieselbe Maschine " +
                        "starten und stoppen würden.",
                    example: null,
                }),
            available_actions: z.array(ActionSchema).openapi({
                description:
                    "Was für diese Leistung ausgelöst werden kann. Ein " +
                    "Kundenschlüssel darf genau diese; " +
                    "`provision`, `suspend`, `unsuspend` und `terminate` " +
                    "bleiben der Verwaltung vorbehalten.",
            }),
            server_id: zId("server").nullable().optional().openapi({
                description: "Auf welchem Server sie liegt. Nur Verwaltung.",
            }),
            server_name: z.string().nullable().optional().openapi({
                description: "Der Name dieses Servers. Nur Verwaltung.",
                example: "pve-fra-1",
            }),
            external_id: z
                .string()
                .nullable()
                .optional()
                .openapi({
                    description:
                        "Die Kennung, unter der die Virtualisierung die Maschine " +
                        "führt — bei Proxmox die VMID. Nur Verwaltung.",
                    example: "101",
                }),
            module_data: z.record(z.string(), z.unknown()).optional().openapi({
                description: "Was das Modul sich notiert hat. Nur Verwaltung.",
            }),
            tasks: z.array(TaskSchema).optional().openapi({
                description: "Die letzten Aufrufe des Moduls. Nur Verwaltung.",
            }),
        })
        .openapi({
            description:
                "Eine Leistung mit allem, was zu ihr gehört. Zugangsdaten " +
                "stehen **nicht** darin: ein Passwort wird nur über den " +
                "Kundenbereich herausgegeben, und dieser Zugriff wird " +
                "protokolliert.",
        }),
);

const ActionResultSchema = registry.register(
    "ServiceActionResult",
    z
        .object({
            task_id: zId("provtask").nullable().openapi({
                description: "Die Anfrage, die dafür eingereiht wurde.",
            }),
            ok: z.boolean().openapi({
                description: "Ob die Aktion durchging.",
                example: true,
            }),
            already_done: z.boolean().openapi({
                description:
                    "Es war nichts zu tun, weil es schon so war — die " +
                    "Maschine lief bereits, oder sie war bereits aus. Das " +
                    "ist **ein Erfolg**.",
                example: false,
            }),
            terminal: z.boolean().openapi({
                description:
                    "Es wird nichts mehr automatisch versucht. Bei " +
                    "`ok: false` heißt das: jemand muss nachsehen.",
                example: false,
            }),
            summary: z.string().openapi({
                description: "Was passiert ist, in einem Satz.",
                example: "VM 101 neu gestartet.",
            }),
            warnings: z.array(z.string()).openapi({
                description:
                    "Was nicht geklappt hat, ohne die Aktion scheitern zu " +
                    "lassen — etwa eine Sperre, die ein eingeschränkter " +
                    "API-Token nicht setzen darf, oder ein Datenträger, den " +
                    "Proxmox nicht verkleinern kann.",
                example: [],
            }),
        })
        .openapi({
            description:
                "Das Ergebnis einer Aktion. Sie wird sofort ausgeführt, " +
                "nicht nur eingereiht, damit die Antwort sagt, was wirklich " +
                "geschehen ist.",
        }),
);

registry.registerPath({
    method: "get",
    path: "/api/v1/services",
    tags: ["Leistungen"],
    summary: "Leistungen auflisten",
    description:
        "Die bereitgestellten Leistungen, seitenweise nach ID. Ein " +
        "Kundenschlüssel sieht ausschließlich die eigenen — der Zuschnitt " +
        "kommt aus dem Schlüssel, nicht aus einem Parameter. Abgebaute " +
        "Leistungen bleiben außen vor, sofern nicht ausdrücklich verlangt.",
    security: SECURITY,
    request: {
        query: z.object({
            status: z
                .enum([
                    "pending",
                    "provisioning",
                    "active",
                    "suspended",
                    "terminated",
                ])
                .optional()
                .openapi({
                    param: { name: "status", in: "query" },
                    description: "Nur Leistungen in diesem Stand.",
                    example: "active",
                }),
            include_terminated: z
                .enum(["true", "false"])
                .optional()
                .openapi({
                    param: { name: "include_terminated", in: "query" },
                    description:
                        "Abgebaute Leistungen mitzählen. Standard `false`.",
                    example: "false",
                }),
            cursor: z
                .string()
                .optional()
                .openapi({
                    param: { name: "cursor", in: "query" },
                    description:
                        "`next_cursor` der vorherigen Seite. Fehlt er, " +
                        "beginnt die Liste am Anfang.",
                    example: "service_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                }),
            limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(200)
                .optional()
                .openapi({
                    param: { name: "limit", in: "query" },
                    description: "Zeilen pro Seite, höchstens 200.",
                    example: 50,
                }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Leistungen.",
            content: {
                "application/json": {
                    schema: cursorPage(ServiceRowSchema, "ServicePage"),
                },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/services/{id}",
    tags: ["Leistungen"],
    summary: "Eine Leistung ansehen",
    description:
        "Eine Leistung mit ihren Adressen, dem letzten Abruf von der " +
        "Virtualisierung und den Aktionen, die für sie vorgesehen sind. Ein " +
        "Schlüssel der Verwaltung sieht zusätzlich Server, Kennung und die " +
        "letzten Moduls-Aufrufe.\n\n" +
        "Eine Leistung, die dieser Schlüssel nicht sehen darf, beantwortet " +
        "diese Route mit **404 und nicht mit 403** — ein 403 würde " +
        "bestätigen, dass es die ID gibt.",
    security: SECURITY,
    request: {
        params: z.object({
            id: zId("service").openapi({
                param: { name: "id", in: "path" },
                description: "Die Leistung.",
            }),
        }),
    },
    responses: {
        200: {
            description: "Die Leistung.",
            content: { "application/json": { schema: ServiceSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/services/{id}/actions/{action}",
    tags: ["Leistungen"],
    summary: "Eine Aktion auf einer Leistung auslösen",
    description:
        "Löst eine Aktion aus und **führt sie sofort aus**, damit die " +
        "Antwort sagt, was wirklich geschehen ist.\n\n" +
        "`start`, `stop`, `shutdown`, `reboot` und `reinstall` darf auch ein " +
        "Kundenschlüssel, sofern das Modul sie für diese Leistung anbietet. " +
        "`provision`, `suspend`, `unsuspend` und `terminate` bleiben der " +
        "Verwaltung vorbehalten; `sync` holt nur einen frischen Stand.\n\n" +
        "Auf einer Leistung, die nicht `active` ist, wird **keine** Aktion " +
        "ausgeführt. Sonst wäre eine wegen einer offenen Rechnung gesperrte " +
        "Maschine einen Knopfdruck weit davon entfernt, wieder zu laufen.\n\n" +
        "Ein Neustart ist nicht wiederholbar: zweimal drücken heißt zweimal " +
        "neu starten, und ein fehlgeschlagener Versuch wird nicht " +
        "automatisch nachgeholt.",
    security: SECURITY,
    request: {
        params: z.object({
            id: zId("service").openapi({
                param: { name: "id", in: "path" },
                description: "Die Leistung.",
            }),
            action: z.enum(SERVICE_ACTIONS).openapi({
                param: { name: "action", in: "path" },
                description: "Die Aktion.",
                example: "reboot",
            }),
        }),
    },
    responses: {
        200: {
            description: "Die Aktion wurde ausgeführt.",
            content: { "application/json": { schema: ActionResultSchema } },
        },
        409: {
            description:
                "Die Aktion ist für diese Leistung nicht vorgesehen, die " +
                "Leistung ist nicht `active`, oder die Anfrage hat ihre " +
                "Versuche aufgebraucht.",
            content: { "application/problem+json": { schema: ProblemSchema } },
        },
        502: {
            description:
                "Die Virtualisierung hat die Aktion abgelehnt oder war nicht " +
                "erreichbar. Der Körper hat dieselbe Gestalt wie bei 200, mit " +
                "`ok: false` — ein Client liest `ok` und rät nicht am " +
                "Statuscode.",
            content: { "application/json": { schema: ActionResultSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});
