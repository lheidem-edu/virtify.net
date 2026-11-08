/**
 * Making an email's HTML safe enough to show a member of staff.
 *
 * **What actually protects the page is not this file.** The conversation
 * renders a message's HTML inside `<iframe sandbox srcdoc=…>` with no
 * `allow-scripts` and no `allow-same-origin`, which is a boundary the
 * *browser* enforces: script does not run, there is no access to our origin,
 * and forms and top-level navigation are off. This function is the second
 * layer, and it is written on the assumption that it has holes — a hand-
 * written HTML sanitiser always does, which is exactly why it is not the
 * only thing standing there.
 *
 * No new dependency (hard rule 12): `sanitize-html` wants `htmlparser2` and
 * most of the alternatives want a DOM. The pair above — an allowlist pass
 * plus a sandboxed frame — is what this needs, and the frame is the half
 * that cannot be argued with.
 */

/**
 * Elements whose content is **raw text, not markup**, so an unclosed one
 * swallows everything after it — which is what a browser does, and what a
 * truncated (or deliberately unclosed) `<script>` relies on. Removing only
 * the tag would leave `alert(1)` standing as the sender's "text".
 */
const RAW_TEXT_OUT = [
    "script",
    "style",
    "noscript",
    "template",
    "title",
    "textarea",
    "svg",
    "math",
];

/** Elements whose *content* is not text and must go with the tag. */
const VOID_OUT = new Set([
    "script",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "noscript",
    "template",
    "svg",
    "math",
    "base",
    "link",
    "meta",
    "title",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "video",
    "audio",
    "source",
]);

/** Everything a mail is allowed to keep. Anything else is unwrapped. */
const ALLOWED = new Set([
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "center",
    "code",
    "col",
    "colgroup",
    "dd",
    "div",
    "dl",
    "dt",
    "em",
    "figure",
    "figcaption",
    "font",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
]);

const SELF_CLOSING = new Set(["br", "hr", "img", "col"]);

/**
 * The exact `id` values a mail client marks its quoted history with.
 *
 * `id` is otherwise dropped, and deliberately: an arbitrary one is a DOM
 * clobbering primitive. These three are not arbitrary — they are a fixed
 * vocabulary Outlook and Outlook Web use — and without them
 * `stripQuotedHtml` cannot see where the quote begins, because sanitising
 * happens first. Half the quote markers in `quoting.ts` were being erased
 * by this file before the stripper ever ran, so an Outlook reply arrived
 * with the whole thread under it and every round trip quoted the quote.
 */
const QUOTE_IDS = new Set(["divrplyfwdmsg", "appendonsend", "signature"]);

/**
 * Attributes that may survive, per tag. `style` is kept — an email without
 * it is unreadable — but filtered below, because `style` is where
 * `expression()`, `url(javascript:…)` and `position:fixed` live.
 */
const ATTRIBUTES: Record<string, Set<string>> = {
    "*": new Set([
        "style",
        "class",
        "dir",
        "align",
        "title",
        "lang",
        // Both filtered by value below; both inert, and both are markers
        // the quote stripper reads. The second is our own, put on every
        // outbound reply so a client we have never seen is still stripped.
        "id",
        "data-virtify-quote",
    ]),
    /**
     * No `target` and no `rel` from the sender: both are appended below, and
     * a duplicate attribute in HTML is won by the *first* one — so a mail
     * carrying `rel="opener"` would have kept it and the sanitiser's own
     * `noopener` would have been the one ignored.
     */
    a: new Set(["href"]),
    img: new Set(["src", "alt", "width", "height"]),
    td: new Set(["colspan", "rowspan", "valign", "bgcolor", "width", "height"]),
    th: new Set(["colspan", "rowspan", "valign", "bgcolor", "width", "height"]),
    table: new Set([
        "border",
        "cellpadding",
        "cellspacing",
        "width",
        "bgcolor",
    ]),
    tr: new Set(["valign", "bgcolor"]),
    col: new Set(["width", "span"]),
    font: new Set(["color", "face", "size"]),
    // `type="cite"` is Apple Mail's quote marker; the value is checked below.
    blockquote: new Set(["cite", "type"]),
};

/**
 * Drops the characters a regex character class cannot carry without Biome's
 * `noControlCharactersInRegex` objecting — and it is right to object, because
 * a control character typed into a pattern is nearly always a mistake. Here
 * it is the point: `java\tscript:` is a scheme a browser still runs, and a
 * filename with a newline in it is a header-injection attempt.
 */
export function stripControlCharacters(
    value: string,
    options: { alsoSpace?: boolean } = {},
): string {
    const floor = options.alsoSpace ? 0x20 : 0x1f;
    let out = "";

    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;

        if (code > floor && code !== 0x7f) {
            out += char;
        }
    }

    return out;
}

/** A URL that is safe to put in an `href` or a `src`. */
export function safeUrl(value: string, allowData: boolean): string | null {
    // Entities, tabs and newlines inside a scheme are the oldest trick
    // there is: `java&#09;script:` is a scheme a browser still runs.
    const cleaned = stripControlCharacters(
        value
            .replace(/&#(\d+);?/g, (_, code: string) =>
                String.fromCharCode(Number(code)),
            )
            .replace(/&#x([0-9a-f]+);?/gi, (_, code: string) =>
                String.fromCharCode(Number.parseInt(code, 16)),
            ),
        { alsoSpace: true },
    ).trim();

    if (cleaned === "") {
        return null;
    }

    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1]?.toLowerCase();

    if (!scheme) {
        // Relative — which in a sandboxed frame with no base resolves to
        // nothing. Harmless, and the alternative loses anchors.
        return cleaned;
    }

    if (["http", "https", "mailto", "tel", "cid"].includes(scheme)) {
        return cleaned;
    }

    if (
        allowData &&
        scheme === "data" &&
        /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(
            cleaned,
        )
    ) {
        return cleaned;
    }

    return null;
}

/**
 * Keeps the declarations that make a mail readable and drops the ones that
 * make it dangerous or let it escape its frame.
 */
export function safeStyle(value: string): string {
    const declarations = value
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);

    const kept: string[] = [];

    for (const declaration of declarations) {
        const index = declaration.indexOf(":");

        if (index <= 0) {
            continue;
        }

        const property = declaration.slice(0, index).trim().toLowerCase();
        const body = declaration.slice(index + 1).trim();

        if (property.startsWith("-") || property.includes("behavior")) {
            continue;
        }

        if (/expression\s*\(|javascript\s*:|@import|url\s*\(/i.test(body)) {
            continue;
        }

        // Fixed and sticky let a mail cover the page it is shown in. Inside
        // the frame it would only cover itself, but the frame is not the
        // only consumer — the plain-text fallback is built from this too.
        if (
            property === "position" &&
            ["fixed", "sticky", "absolute"].includes(body.toLowerCase())
        ) {
            continue;
        }

        kept.push(`${property}:${body}`);
    }

    return kept.join(";");
}

function escapeText(value: string): string {
    return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attributesFor(tag: string, raw: string): string {
    const allowed = ATTRIBUTES[tag];
    const common = ATTRIBUTES["*"];
    const out: string[] = [];

    const pattern =
        /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

    for (const match of raw.matchAll(pattern)) {
        const name = match[1].toLowerCase();
        let value = match[2] ?? "";

        if (value.startsWith('"') || value.startsWith("'")) {
            value = value.slice(1, -1);
        }

        // Every event handler, in one rule rather than a list that a new
        // attribute could walk past.
        if (name.startsWith("on") || name.startsWith("xmlns")) {
            continue;
        }

        if (!allowed?.has(name) && !common.has(name)) {
            continue;
        }

        if (name === "href" || name === "src") {
            const url = safeUrl(value, name === "src");

            if (!url) {
                continue;
            }

            value = url;
        }

        if (name === "style") {
            value = safeStyle(value);

            if (value === "") {
                continue;
            }
        }

        /**
         * The three markers, each narrowed to the one thing it is for. An
         * `id` outside the fixed vocabulary goes, `type` survives only as
         * `cite`, and ours is rewritten to a constant — so none of them can
         * carry a value a sender chose.
         */
        if (name === "id" && !QUOTE_IDS.has(value.trim().toLowerCase())) {
            continue;
        }

        if (name === "type" && value.trim().toLowerCase() !== "cite") {
            continue;
        }

        if (name === "data-virtify-quote") {
            value = "1";
        }

        out.push(
            `${name}="${value
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")}"`,
        );
    }

    if (tag === "a") {
        // A link in a ticket opens somewhere else, and the page it opens
        // must not get a handle on ours.
        out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    }

    return out.length > 0 ? ` ${out.join(" ")}` : "";
}

/**
 * Allowlist pass over an email body.
 *
 * A tokeniser rather than a parser: comments, CDATA and the contents of
 * `script`/`style` are removed outright, every tag is either kept with its
 * surviving attributes or unwrapped, and everything else becomes text. It
 * does not repair broken nesting — the browser does that, inside the frame.
 */
export function sanitizeHtml(input: string | null | undefined): string {
    if (!input) {
        return "";
    }

    let html = input;

    // Comments first: `<!-- <script> -->` and the conditional comments
    // Outlook leaves behind are both full of tags this pass should not see.
    html = html.replace(/<!--[\s\S]*?-->/g, "");
    html = html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    html = html.replace(/<\?[\s\S]*?\?>/g, "");
    html = html.replace(/<![^>]*>/g, "");

    for (const tag of VOID_OUT) {
        html = html.replace(
            new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
            "",
        );
    }

    // An unclosed raw-text element takes the rest of the document with it.
    for (const tag of RAW_TEXT_OUT) {
        html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, "i"), "");
    }

    // Whatever opening or closing tags are left of them.
    for (const tag of VOID_OUT) {
        html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
    }

    const out: string[] = [];
    /**
     * A tag name follows `<` or `</` **immediately**. Allowing whitespace
     * there is not generosity, it is a bug: a browser reads `a < b und c > d`
     * as text, and a sanitiser that reads it as `<b>` has invented markup
     * the sender never wrote — and worse, has stopped escaping the `<`.
     */
    const pattern =
        /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let cursor = 0;

    for (const match of html.matchAll(pattern)) {
        const index = match.index ?? 0;

        out.push(escapeText(html.slice(cursor, index)));
        cursor = index + match[0].length;

        const closing = match[1] === "/";
        const tag = match[2].toLowerCase();

        if (!ALLOWED.has(tag)) {
            // Unwrapped, not removed: the text inside an unknown element is
            // still the sender's message.
            continue;
        }

        if (closing) {
            if (!SELF_CLOSING.has(tag)) {
                out.push(`</${tag}>`);
            }

            continue;
        }

        const attributes = attributesFor(tag, match[3] ?? "");

        out.push(
            SELF_CLOSING.has(tag)
                ? `<${tag}${attributes} />`
                : `<${tag}${attributes}>`,
        );
    }

    out.push(escapeText(html.slice(cursor)));

    return out.join("");
}

/** A readable plain-text rendering of an HTML body, for the text part and search. */
export function htmlToText(input: string | null | undefined): string {
    if (!input) {
        return "";
    }

    return input
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);?/g, (_, code: string) =>
            String.fromCharCode(Number(code)),
        )
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
