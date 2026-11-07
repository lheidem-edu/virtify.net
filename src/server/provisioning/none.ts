import { z } from "zod";
import type { ProvisioningModule } from "./types";

/**
 * Nothing is provisioned.
 *
 * Every product starts here, and a `subscription` product — a support plan, a
 * managed service, a licence — stays here for good: it is billed like any
 * other product and there is simply no machine at the end of it.
 *
 * The schema is strict rather than permissive on purpose. Switching a product
 * from a real module back to `none` would otherwise keep that module's
 * settings in the jsonb column, where the next reader would find
 * configuration for a module the product no longer uses.
 */
export const noneModule: ProvisioningModule<Record<string, never>> = {
    id: "none",
    label: "Keine Bereitstellung",
    description:
        "Das Produkt wird nur abgerechnet. Nichts wird automatisch eingerichtet — " +
        "richtig für Supportverträge, Lizenzen und alles, was von Hand bereitgestellt wird.",
    configSchema: z.strictObject({}),
    provisions: false,
};
