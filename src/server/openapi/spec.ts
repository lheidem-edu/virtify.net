import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import "./paths";
import { registry } from "./registry";

const DESCRIPTION = `
Die REST-Schnittstelle des Abrechnungsportals von **virtify.net**.

## Authentifizierung

Jede Anfrage trägt einen API-Schlüssel im Kopf:

\`\`\`
Authorization: Bearer vfy_…
\`\`\`

Schlüssel werden im Kunden- oder Verwaltungsbereich erzeugt, genau einmal
angezeigt und nur als Hash gespeichert. Ein Kundenschlüssel sieht ausschließlich
die Daten seines eigenen Kundenkontos.

## Seitenweise Abfrage

Listen werden über einen Cursor geblättert, nicht über einen Offset. Jede Antwort
enthält \`next_cursor\` und \`has_more\`; der Cursor ist die zuletzt gesehene ID.
Dadurch kann sich eine Seite nicht verschieben, während gelesen wird.

## Fehler

Fehler folgen RFC 9457 und kommen als \`application/problem+json\` mit \`type\`,
\`title\`, \`status\` und \`detail\`.

## Beträge

Alle Beträge sind ganzzahlige Cent, nie Kommazahlen, und tragen ihre Währung
neben sich. \`1999\` bei \`EUR\` sind 19,99 €.

---

The billing panel's REST API. Authenticate with an API key as a bearer token,
page through lists with the opaque \`cursor\`, read errors as RFC 9457
problem documents, and treat every amount as integer minor units.
`.trim();

/**
 * Deterministic: it reads no environment and no clock, so the document served
 * live and the one written to public/openapi.json are the same bytes, and a
 * test can say so.
 *
 * `version` is the API's, not the build's. The revision that is running is
 * what GET /api/v1/health answers.
 */
export function buildSpec() {
    return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: "3.1.0",
        info: {
            title: "virtify.net API",
            version: "0.1.0",
            description: DESCRIPTION,
            contact: { name: "virtify.net", url: "https://virtify.net" },
        },
        // Relative, so the API is wherever the specification was fetched from.
        // A hard-coded origin would be wrong on every instance but one.
        servers: [{ url: "/", description: "Diese Instanz" }],
        tags: [
            {
                name: "System",
                description: "Erreichbarkeit und Fassung der Schnittstelle.",
            },
            {
                name: "Katalog",
                description:
                    "Produkte, Preise und Zusatzleistungen — und die Funktion, " +
                    "die daraus einen Preis macht.",
            },
            {
                name: "Rechnungen",
                description:
                    "Rechnungen und ihre Positionen. Eine ausgestellte " +
                    "Rechnung ist unveränderlich; korrigiert wird über eine " +
                    "Rechnungskorrektur mit eigener Nummer.",
            },
            {
                name: "Kunden",
                description:
                    "Kundenkonten: Stammdaten, Status und Kundennummer. " +
                    "Ein Kundenschlüssel sieht hier ausschließlich das eigene Konto.",
            },
        ],
    });
}
