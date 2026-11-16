import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A settings read that fails, in the two processes that read settings.
 *
 * A page may fall back to the built-in defaults: a storefront should still
 * render while the database is briefly unreachable. The worker may not. A
 * worker that came up against a database nine migrations behind logged
 * `column "operator_tax_number" does not exist` and then ran its mail pass on
 * the defaults anyway — and the 03:00 billing run would have climbed the
 * dunning ladder with days and fees nobody configured.
 */

const failing = vi.hoisted(() => ({ throws: true }));

vi.mock("@/db", async (original) => {
    const actual = await original<typeof import("@/db")>();
    const fail = () => {
        const error = new Error(
            'column "operator_tax_number" does not exist',
        ) as Error & { code: string };

        error.code = "42703";

        return error;
    };

    return {
        ...actual,
        db: {
            select: () => ({
                from: () => ({
                    where: async () => {
                        if (failing.throws) {
                            throw fail();
                        }

                        return [];
                    },
                }),
            }),
        },
    };
});

describe("a settings read that fails", () => {
    beforeEach(() => {
        vi.resetModules();
        failing.throws = true;
    });

    it("falls back to the defaults for a page", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { defaultSettings, loadSettings } = await import(
            "@/server/settings"
        );

        await expect(loadSettings()).resolves.toEqual(defaultSettings);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it("throws in the worker, so a pass fails instead of billing on the defaults", async () => {
        const { loadSettings, refuseSettingsFallback } = await import(
            "@/server/settings"
        );

        refuseSettingsFallback();

        await expect(loadSettings()).rejects.toThrow(/operator_tax_number/);
    });

    it("still takes the defaults in the worker when there is simply no row yet", async () => {
        /**
         * A missing row is a fresh installation whose operator has not
         * opened the settings page, not an error — refusing it would stop
         * every new panel's worker before anybody had a chance to configure
         * anything.
         */
        failing.throws = false;

        const { defaultSettings, loadSettings, refuseSettingsFallback } =
            await import("@/server/settings");

        refuseSettingsFallback();

        await expect(loadSettings()).resolves.toEqual(defaultSettings);
    });
});
