/**
 * Light, dark, or whatever the machine says.
 *
 * Until Phase 9 the root element carried a hardcoded `dark` and nothing
 * selected the light tokens that have been sitting in `tailwind.css` since the
 * scaffold. Three things changed that: a portal is read on a phone in
 * daylight, an invoice is read next to a printed one, and the customer gets
 * to decide.
 *
 * **Dark stays the default**, including for a visitor with no cookie. It is
 * what this site looks like, and "system" as the default would mean the
 * product's own appearance depended on an operating-system setting nobody
 * chose with this site in mind.
 */

export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";

export const THEME_COOKIE = "virtify_theme";

export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: unknown): value is Theme {
    return (
        typeof value === "string" &&
        (THEMES as readonly string[]).includes(value)
    );
}

export function toTheme(value: unknown): Theme {
    return isTheme(value) ? value : DEFAULT_THEME;
}

/**
 * Whether the server should render the `dark` class for this preference.
 *
 * `system` renders dark and lets the inline script correct it: the script is
 * synchronous and in `<head>`, so it runs before the first paint, and
 * guessing dark means the common case — a dark site on a dark desktop —
 * never flickers at all.
 */
export function rendersDark(theme: Theme): boolean {
    return theme !== "light";
}

/**
 * The script that reconciles `system` with the machine before paint.
 *
 * Inline and tiny on purpose: a separate file would be a network round trip
 * in front of the first paint, which is exactly the flash it exists to
 * prevent. It reads the cookie rather than being handed the value, so it is
 * one constant string and not a template the server interpolates into —
 * nothing user-controlled is ever concatenated into it.
 */
export const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=([^;]*)/);var t=m?decodeURIComponent(m[1]):"${DEFAULT_THEME}";var d=t==="dark"||(t!=="light"&&t!=="system"?true:t==="system"?window.matchMedia("(prefers-color-scheme: dark)").matches:false);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
