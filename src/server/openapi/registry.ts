import {
    extendZodWithOpenApi,
    OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * Teaches zod the `.openapi()` method the generator reads. It has to run
 * before any schema calls it, which is why every OpenAPI module imports the
 * registry from here rather than constructing one of its own.
 */
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

/**
 * API keys travel as `Authorization: Bearer vfy_…`. They are hashed at rest
 * (`hashToken` in src/lib/crypto.ts) and scoped to a customer or to staff, so
 * a key can never read more than its owner can.
 */
export const apiKeyAuth = registry.registerComponent(
    "securitySchemes",
    "ApiKey",
    {
        type: "http",
        scheme: "bearer",
        description:
            "Ein API-Schlüssel aus dem Kunden- oder Verwaltungsbereich. " +
            "Er wird genau einmal angezeigt und nur als Hash gespeichert.",
    },
);

export { z };
