import { noneModule } from "./none";
import { proxmoxModule } from "./proxmox/module";
import type { ProvisioningModule } from "./types";

/**
 * The registry. A product's `module` column and a server's are looked up
 * here, and an id that is not registered is an error rather than a silently
 * inert row — a module removed from a running installation has to be
 * noticed, not ignored.
 */
const MODULES: ProvisioningModule[] = [
    noneModule as ProvisioningModule<unknown, unknown>,
    proxmoxModule as ProvisioningModule<unknown, unknown>,
];

export const DEFAULT_MODULE = noneModule.id;

export function listModules(): readonly ProvisioningModule[] {
    return MODULES;
}

export function moduleIds(): string[] {
    return MODULES.map((entry) => entry.id);
}

/** The ones a server row can be made for: everything that provisions. */
export function serverModuleIds(): string[] {
    return MODULES.filter((entry) => entry.provisions).map((entry) => entry.id);
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

function describe(error: {
    issues: { path: PropertyKey[]; message: string }[];
}): string {
    const first = error.issues[0];

    return `${first?.path.join(".") || "(Wurzel)"} — ${first?.message}`;
}

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
        throw new ModuleConfigError(
            `Die Moduleinstellungen für „${entry.label}“ sind nicht gültig: ` +
                describe(parsed.error),
        );
    }

    return (parsed.data ?? {}) as Record<string, unknown>;
}

/**
 * The same for a server row. Separate because the two schemas answer
 * different questions — "what does this product order" and "where does it go"
 * — and a module may well take settings in one and nothing in the other.
 */
export function parseServerConfig(
    moduleId: string,
    config: unknown,
): Record<string, unknown> {
    const entry = getModule(moduleId);

    if (!entry) {
        throw new UnknownModuleError(moduleId);
    }

    if (!entry.provisions) {
        throw new ModuleConfigError(
            `„${entry.label}“ stellt nichts bereit — dafür gibt es keine Server.`,
        );
    }

    const parsed = entry.serverSchema.safeParse(config ?? {});

    if (!parsed.success) {
        throw new ModuleConfigError(
            `Die Servereinstellungen für „${entry.label}“ sind nicht gültig: ` +
                describe(parsed.error),
        );
    }

    return (parsed.data ?? {}) as Record<string, unknown>;
}

export type { ProvisioningModule };
export { noneModule, proxmoxModule };
