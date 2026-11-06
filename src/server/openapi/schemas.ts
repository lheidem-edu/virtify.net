import type { ZodType } from "zod";
import { registry, z } from "./registry";

/**
 * Errors are RFC 9457 `application/problem+json`, so a client can tell what
 * went wrong from the body alone rather than from the status code plus a
 * house-style envelope it has to learn.
 */
export const ProblemSchema = registry.register(
    "Problem",
    z
        .object({
            type: z.string().openapi({
                description:
                    "URI die den Fehlertyp benennt. `about:blank` heißt: der Statuscode sagt schon alles.",
                example: "https://virtify.net/problems/validation-failed",
            }),
            title: z.string().openapi({
                description: "Kurze, für den Typ stets gleiche Beschreibung.",
                example: "Die Anfrage war nicht gültig.",
            }),
            status: z.int().min(100).max(599).openapi({
                description: "Der HTTP-Statuscode, wiederholt im Körper.",
                example: 422,
            }),
            detail: z.string().optional().openapi({
                description: "Was in genau diesem Fall schiefging.",
                example: "`limit` muss zwischen 1 und 100 liegen.",
            }),
            instance: z.string().optional().openapi({
                description: "Die Anfrage, bei der es auftrat.",
                example: "/api/v1/invoices?limit=500",
            }),
            errors: z
                .array(
                    z.object({
                        path: z.string().openapi({ example: "limit" }),
                        message: z
                            .string()
                            .openapi({ example: "Höchstens 100." }),
                    }),
                )
                .optional()
                .openapi({
                    description:
                        "Feldweise Begründung, wenn die Prüfung einer Eingabe fehlschlug.",
                }),
        })
        .openapi({
            description:
                "Fehlerantwort nach RFC 9457, ausgeliefert als `application/problem+json`.",
        }),
);

export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Cursor pagination, not offset: the cursor is the last ULID seen, so a page
 * cannot shift under the reader when a row is inserted while they page
 * through — and `WHERE id > $cursor ORDER BY id` uses the primary key index.
 */
export const CursorQuerySchema = z.object({
    cursor: z
        .string()
        .optional()
        .openapi({
            param: { name: "cursor", in: "query" },
            description:
                "`next_cursor` der vorherigen Seite. Fehlt er, beginnt die Liste am Anfang.",
            example: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
        }),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .openapi({
            param: { name: "limit", in: "query" },
            description: "Zeilen pro Seite, höchstens 100.",
            example: 25,
        }),
});

/** Wraps a page of `item` in the envelope every list endpoint returns. */
export function cursorPage<T extends ZodType>(item: T, refId: string) {
    return registry.register(
        refId,
        z.object({
            data: z.array(item),
            next_cursor: z.string().nullable().openapi({
                description:
                    "An die nächste Anfrage als `cursor` weitergeben; `null` auf der letzten Seite.",
                example: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
            }),
            has_more: z.boolean().openapi({
                description: "Ob nach dieser Seite noch Zeilen folgen.",
                example: false,
            }),
        }),
    );
}

/** The error responses every endpoint can produce, ready to spread. */
export const PROBLEM_RESPONSES = {
    400: {
        description: "Die Anfrage war syntaktisch falsch.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
        description: "Kein oder kein gültiger API-Schlüssel.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
        description: "Der Schlüssel darf das nicht.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
        description: "Nicht vorhanden — oder nicht für diesen Schlüssel.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
        description: "Die Eingabe hat die Prüfung nicht bestanden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
} as const;
