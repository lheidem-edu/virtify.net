import { z } from "zod";
import type { ProvisioningModule } from "./types";

/**
 * Nothing is provisioned.
 *
 * Every product starts here, and a `subscription` product — a support plan, a
 * managed service, a licence — stays here for good: it is billed like any
 * other product and there is simply no machine at the end of it.
 *
 * Both schemas are strict rather than permissive on purpose. Switching a
 * product from a real module back to `none` would otherwise keep that
 * module's settings in the jsonb column, where the next reader would find
 * configuration for a module the product no longer uses — and the empty
 * `serverSchema` is what makes a `none` server a validation error rather
 * than a row nothing can ever run against.
 *
 * It implements none of the lifecycle. That is not a gap: a task is never
 * enqueued for a service whose module does not `provision`, and a module
 * that answered `suspend` with "nothing to do" would make "the machine is
 * stopped" indistinguishable from "there is no machine".
 */
export const noneModule: ProvisioningModule<
    Record<string, never>,
    Record<string, never>
> = {
    id: "none",
    label: "Keine Bereitstellung",
    description:
        "Das Produkt wird nur abgerechnet. Nichts wird automatisch eingerichtet — " +
        "richtig für Supportverträge, Lizenzen und alles, was von Hand bereitgestellt wird.",
    configSchema: z.strictObject({}),
    serverSchema: z.strictObject({}),
    provisions: false,
};
