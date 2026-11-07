import { noneModule } from "./none";
import type { ProvisioningModule } from "./types";

/**
 * The registry. A product's `module` column is looked up here, and an id that
 * is not registered is an error rather than a silently inert product — a
 * module removed from a running installation has to be noticed, not ignored.
 *
 * Phase 8 adds the Proxmox module by importing it and putting it in this list.
 */
const MODULES: ProvisioningModule[] = [
    noneModule as ProvisioningModule<unknown>,
];

export const DEFAULT_MODULE = noneModule.id;

export function listModules(): readonly ProvisioningModule[] {
    return MODULES;
}

export function moduleIds(): string[] {
    return MODULES.map((entry) => entry.id);
}

export function getModule(id: string): ProvisioningModule | null {
    return MODULES.find((entry) => entry.id === id) ?? null;
}

export class UnknownModuleError extends Error {
    constructor(readonly moduleId: string) {
        super(`Unbekanntes Modul: ${moduleId}`);
        this.name = "UnknownModuleError";
    }
}

export class ModuleConfigError extends Error {}

/**
 * Validates a product's module configuration against the schema its module
 * publishes, and hands back what should be stored. Called by every path that
 * writes a product, so a configuration the module cannot read never reaches
 * the column.
 */
export function parseModuleConfig(
    moduleId: string,
    config: unknown,
): Record<string, unknown> {
    const entry = getModule(moduleId);

    if (!entry) {
        throw new UnknownModuleError(moduleId);
    }

    const parsed = entry.configSchema.safeParse(config ?? {});

    if (!parsed.success) {
        const first = parsed.error.issues[0];

        throw new ModuleConfigError(
            `Die Moduleinstellungen für „${entry.label}“ sind nicht gültig: ` +
                `${first?.path.join(".") || "(Wurzel)"} — ${first?.message}`,
        );
    }

    return (parsed.data ?? {}) as Record<string, unknown>;
}

export type { ProvisioningModule };
export { noneModule };
