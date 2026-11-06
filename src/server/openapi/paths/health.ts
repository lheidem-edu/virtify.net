import { registry, z } from "../registry";
import { PROBLEM_RESPONSES } from "../schemas";

export const HealthSchema = registry.register(
    "Health",
    z.object({
        status: z.literal("ok").openapi({
            description: "`ok`, sonst antwortet dieser Endpunkt gar nicht.",
        }),
        time: z.iso.datetime().openapi({
            description: "Serverzeit in UTC, zum Abgleich von Uhren.",
            example: "2026-11-07T08:15:00.000Z",
        }),
        commit: z.string().openapi({
            description: "Die Revision, aus der dieser Build entstand.",
            example: "2c88137",
        }),
    }),
);

registry.registerPath({
    method: "get",
    path: "/api/v1/health",
    tags: ["System"],
    summary: "Erreichbarkeit prüfen",
    description:
        "Antwortet ohne Authentifizierung und ohne Datenbankzugriff. " +
        "Gedacht für Health-Checks des Containers und um zu sehen, welche " +
        "Revision gerade läuft.",
    responses: {
        200: {
            description: "Der Dienst läuft.",
            content: { "application/json": { schema: HealthSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});
