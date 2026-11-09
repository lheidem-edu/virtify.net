import { describe, expect, it } from "vitest";
import {
    getModule,
    listModules,
    ModuleConfigError,
    moduleIds,
    parseModuleConfig,
    parseServerConfig,
    serverModuleIds,
    UnknownModuleError,
} from "@/server/provisioning";
import {
    SERVICE_ACTIONS,
    STAFF_ONLY_ACTIONS,
} from "@/server/provisioning/actions";

/**
 * The registry, and the invariants that hold across every module in it.
 *
 * These are the claims a *second* module would break silently. A registry
 * with one real entry is a registry whose rules have never been tested, so
 * they are written down here rather than discovered when the next one is
 * added.
 */

describe("the registry", () => {
    it("has an id for every module and no duplicates", () => {
        const ids = moduleIds();

        expect(ids).toContain("none");
        expect(ids).toContain("proxmox");
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("offers servers only for the modules that provision something", () => {
        expect(serverModuleIds()).toEqual(["proxmox"]);
        expect(() => parseServerConfig("none", {})).toThrow(ModuleConfigError);
    });

    it("treats an unregistered id as an error, not as an inert product", () => {
        // A module removed from a running installation has to be noticed.
        expect(getModule("vmware")).toBeNull();
        expect(() => parseModuleConfig("vmware", {})).toThrow(
            UnknownModuleError,
        );
    });

    /**
     * Every module has to accept `{}`, because that is what a product
     * carries the instant its module is switched.
     */
    it("lets every module read an empty configuration", () => {
        for (const id of moduleIds()) {
            expect(() => parseModuleConfig(id, {})).not.toThrow();
            expect(() => parseModuleConfig(id, undefined)).not.toThrow();
        }
    });

    it("refuses configuration meant for a different module", () => {
        // Switching a product back to `none` must not leave Proxmox's
        // settings in the column for the next reader to find.
        expect(() => parseModuleConfig("none", { cores: 4 })).toThrow(
            ModuleConfigError,
        );
    });

    /**
     * **The disjointness the customer guard leans on.** A module decides
     * what its machines can be asked to do, and a module that put
     * `terminate` or `unsuspend` on that list would be publishing a
     * lifecycle decision as a customer button. `requestServiceAction` refuses
     * those by name regardless — but this is the property that makes the
     * narrower check sufficient, and it is the one a second module would
     * break without noticing.
     */
    it("never offers a staff-only action as a client action", () => {
        for (const module of listModules()) {
            for (const action of module.clientActions ?? []) {
                expect(STAFF_ONLY_ACTIONS).not.toContain(action.id);
                // And it has to be an action the panel knows at all.
                expect(SERVICE_ACTIONS).toContain(action.id);
            }
        }
    });

    it("keeps the staff-only list to the lifecycle, and all of it", () => {
        expect([...STAFF_ONLY_ACTIONS].sort()).toEqual([
            "provision",
            "suspend",
            "terminate",
            "unsuspend",
        ]);
    });

    it("gives a module that provisions nothing no lifecycle at all", () => {
        const none = getModule("none");

        expect(none?.provisions).toBe(false);
        // Not a gap: a module that answered `suspend` with "nothing to do"
        // would make "the machine is stopped" indistinguishable from "there
        // is no machine".
        expect(none?.create).toBeUndefined();
        expect(none?.suspend).toBeUndefined();
        expect(none?.terminate).toBeUndefined();
    });

    it("gives every module that provisions the whole lifecycle", () => {
        for (const module of listModules()) {
            if (!module.provisions) {
                continue;
            }

            for (const method of [
                "create",
                "suspend",
                "unsuspend",
                "terminate",
                "changePackage",
                "getStatus",
                "testConnection",
            ] as const) {
                expect(typeof module[method]).toBe("function");
            }
        }
    });
});
