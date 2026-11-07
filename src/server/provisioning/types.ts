import type { ZodType } from "zod";

/**
 * What a provisioning module is.
 *
 * A product names one, and the module decides what `product.moduleConfig`
 * may contain — the schema lives with the module rather than in the catalog,
 * so adding Proxmox in Phase 8 adds a file and does not touch the product
 * form, the API or the database.
 *
 * Deliberately only the catalog's half of the contract for now. The lifecycle
 * the build plan describes — `create`, `suspend`, `unsuspend`, `terminate`,
 * `changePackage`, `getStatus`, `testConnection` — belongs to Phase 8, which
 * is also the first phase with anything to run it against. Stubbing it here
 * would be seven methods that throw.
 */
export interface ProvisioningModule<Config = unknown> {
    /** Stored in `product.module`. Stable: it is a value in the database. */
    readonly id: string;
    /** German, shown in the product form. */
    readonly label: string;
    readonly description: string;
    /**
     * Validates and normalises `product.module_config`. It has to accept the
     * empty object, because that is what a product carries the moment its
     * module is switched.
     */
    readonly configSchema: ZodType<Config>;
    /** Whether ordering this product creates something to be provisioned. */
    readonly provisions: boolean;
}
