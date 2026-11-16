import { createTranslator } from "use-intl/core";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import { DEFAULT_LOCALE, type Locale } from "./locale";

/**
 * The message catalogue, and a translator that works anywhere.
 *
 * ## Why `use-intl/core` and not `next-intl`
 *
 * The mail renderer runs in the **worker** — `npm run worker`, a plain Node
 * process with no Next request context at all — and importing `next-intl`
 * there fails on the first line: its root entry re-exports the React
 * bindings, and React's named exports are not resolvable under the worker's
 * conditions. `use-intl/core` is the same library's framework-free entry and
 * it loads in both.
 *
 * So `use-intl` is a dependency of its own in `package.json` rather than
 * being reached through `next-intl`, which happens to depend on it: a
 * transitive version that drifts is a worker that stops sending mail.
 *
 * **One catalogue, two readers.** The JSON below is the same file the UI
 * reads through next-intl. A second set of strings for mail is how a product
 * ends up calling the same thing two names, and the German here is the
 * source (rule 13) — lifted verbatim from the senders that predate this
 * phase, never reworded.
 *
 * The messages are imported statically rather than with `import(…)`: the
 * standalone build traces what it can see, two JSON files are a few kilobytes,
 * and a dynamic import would be one more thing that can be missing at
 * runtime in the container.
 */

export const MESSAGES = { de, en } as const;

/** The shape both files have. `de` is the source, so it defines the keys. */
export type Messages = typeof de;

export function messagesFor(locale: Locale): Messages {
    // `en` is structurally compatible; the test in tests/unit/i18n.test.ts is
    // what actually holds the two files to the same key set, because
    // TypeScript only checks the ones this module names.
    return (MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]) as Messages;
}

/**
 * A translator for one locale and namespace, usable in a request, a job or a
 * test.
 *
 * `onError` is deliberately loud: `use-intl`'s default swallows a missing key
 * and renders the key path, which is how an English mail ships with
 * `mail.welcome.intro2` in the body. A mail is not worth sending wrong, and
 * the outbox treats the throw as a failed render — the row stays, the
 * operator sees why.
 */
export function translator<N extends keyof Messages>(
    locale: Locale,
    namespace: N,
) {
    return createTranslator({
        locale,
        messages: messagesFor(locale),
        namespace,
        onError(error) {
            throw error;
        },
    });
}

export type Translator<N extends keyof Messages> = ReturnType<
    typeof translator<N>
>;
