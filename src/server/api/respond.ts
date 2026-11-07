import type { z } from "zod";
import type { Problem } from "@/server/openapi/schemas";

/**
 * The shapes every `/api/v1` route answers with. Errors are RFC 9457
 * `application/problem+json`, so a client can tell what went wrong from the
 * body rather than from the status code plus house style.
 */

const PROBLEM_TYPE = "https://virtify.net/problems";

export function json<T>(data: T, status = 200): Response {
    return Response.json(data, { status });
}

export function problem(
    status: number,
    title: string,
    detail?: string,
    extra?: Partial<Problem>,
): Response {
    const body: Problem = {
        type: `${PROBLEM_TYPE}/${slug(title)}`,
        title,
        status,
        ...(detail ? { detail } : {}),
        ...extra,
    };

    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/problem+json" },
    });
}

function slug(title: string) {
    return title
        .toLowerCase()
        .replace(/[äöüß]/g, (c) =>
            c === "ä" ? "ae" : c === "ö" ? "oe" : c === "ü" ? "ue" : "ss",
        )
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

export const unauthorized = (detail?: string) =>
    problem(
        401,
        "Nicht authentifiziert",
        detail ??
            "Es fehlt ein gültiger API-Schlüssel im Kopf `Authorization: Bearer`.",
    );

export const forbidden = (detail?: string) =>
    problem(
        403,
        "Nicht erlaubt",
        detail ?? "Dieser Schlüssel hat dafür keine Berechtigung.",
    );

export const notFound = (detail?: string) =>
    problem(
        404,
        "Nicht gefunden",
        detail ?? "Es gibt dazu nichts — oder nichts für diesen Schlüssel.",
    );

/**
 * A failed zod parse, field by field. The 422 is deliberate: the request was
 * well-formed JSON, it just said something that is not allowed.
 */
export function invalid(error: z.ZodError): Response {
    return problem(
        422,
        "Eingabe ungültig",
        "Mindestens ein Feld hat die Prüfung nicht bestanden.",
        {
            errors: error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
            })),
        },
    );
}

export const malformed = (detail?: string) =>
    problem(
        400,
        "Anfrage fehlerhaft",
        detail ?? "Der Körper der Anfrage ist kein gültiges JSON.",
    );
