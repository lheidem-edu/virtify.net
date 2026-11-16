import { describe, expect, it } from "vitest";
import {
    DEFAULT_THEME,
    isTheme,
    rendersDark,
    THEME_COOKIE,
    THEME_SCRIPT,
    toTheme,
} from "@/lib/theme";

/**
 * Light, dark, or whatever the machine says.
 *
 * Small, but the two things it checks are the ones that go wrong: what the
 * *server* renders before any script runs, and whether the inline script that
 * corrects it can be made to carry something it should not.
 */

describe("the theme preference", () => {
    it("is dark by default, including for a visitor with no cookie", () => {
        expect(DEFAULT_THEME).toBe("dark");
        expect(toTheme(undefined)).toBe("dark");
        expect(toTheme("")).toBe("dark");
        // A stale or hand-edited cookie must not break a page.
        expect(toTheme("midnight")).toBe("dark");
    });

    it("knows its three values", () => {
        expect(isTheme("system")).toBe(true);
        expect(isTheme("light")).toBe(true);
        expect(isTheme("dark")).toBe(true);
        expect(isTheme("auto")).toBe(false);
        expect(isTheme(null)).toBe(false);
    });

    it("renders dark for everything except an explicit light", () => {
        // `system` renders dark and lets the script correct it: the script is
        // synchronous and in `<head>`, so guessing dark means the common case
        // — a dark site on a dark desktop — never flickers at all.
        expect(rendersDark("dark")).toBe(true);
        expect(rendersDark("system")).toBe(true);
        expect(rendersDark("light")).toBe(false);
    });

    it("has nothing interpolated into the inline script", () => {
        // It goes out through `dangerouslySetInnerHTML`, so the only safe
        // version of it is one that is a constant: it reads the cookie itself
        // rather than being handed the value.
        expect(THEME_SCRIPT).toContain(THEME_COOKIE);
        expect(THEME_SCRIPT).not.toContain("${");
        expect(THEME_SCRIPT).not.toContain("</script");
        // And it never throws into the page it is blocking.
        expect(THEME_SCRIPT).toContain("catch");
    });
});
