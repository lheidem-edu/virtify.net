import { describe, expect, it } from "vitest";
import {
    htmlToText,
    safeStyle,
    safeUrl,
    sanitizeHtml,
} from "@/server/tickets/sanitize";

/**
 * The allowlist pass over an email body.
 *
 * It is the *second* layer — the conversation renders this inside
 * `<iframe sandbox srcdoc=…>` with neither `allow-scripts` nor
 * `allow-same-origin`, which is what actually stops script running. These
 * cases exist because the second layer should still hold on its own, and
 * because the stripped text is built from this output and reaches places
 * that have no frame around them.
 */

describe("sanitizeHtml", () => {
    it("removes a script and everything in it", () => {
        const out = sanitizeHtml(
            "<p>Hallo</p><script>fetch('/api/v1/invoices')</script>",
        );

        expect(out).toContain("Hallo");
        expect(out).not.toContain("script");
        expect(out).not.toContain("fetch");
    });

    it("removes an unclosed script tag too", () => {
        const out = sanitizeHtml("<p>a</p><script>alert(1)");

        expect(out).not.toContain("alert");
        expect(out).not.toContain("<script");
    });

    it("drops every event handler, not a list of them", () => {
        for (const attribute of [
            "onclick",
            "onerror",
            "onload",
            "onmouseover",
            "onfocus",
            "onsomethingnobodyhasinventedyet",
        ]) {
            const out = sanitizeHtml(`<img src="x.png" ${attribute}="evil()">`);

            expect(out).not.toContain(attribute);
            expect(out).not.toContain("evil");
        }
    });

    it("refuses a javascript: href, however it is spelled", () => {
        for (const href of [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "  javascript:alert(1)",
            "java\tscript:alert(1)",
            "java&#09;script:alert(1)",
            "&#106;avascript:alert(1)",
            "vbscript:msgbox(1)",
        ]) {
            const out = sanitizeHtml(`<a href="${href}">x</a>`);

            expect(out.toLowerCase()).not.toContain("javascript:");
            expect(out.toLowerCase()).not.toContain("vbscript:");
            expect(out).not.toContain("alert");
        }
    });

    it("keeps the links a mail is actually made of", () => {
        const out = sanitizeHtml(
            '<a href="https://example.net/x?a=1&b=2">Link</a>',
        );

        expect(out).toContain("https://example.net/x?a=1&amp;b=2");
        expect(out).toContain('rel="noopener noreferrer nofollow"');
        expect(out).toContain('target="_blank"');
    });

    it("stays linear on a mail built to make it quadratic", () => {
        /**
         * `<a ` with no `>` after it used to make the attribute run consume
         * to the end of the document and give it back one character at a
         * time, once per opening. Eight hundred such openings in 800 KB took
         * half a second, and doubling the input quadrupled it — so a few
         * megabytes was a worker held for a minute, re-sanitising the same
         * message every five minutes because the delta cursor now waits.
         *
         * The budget is deliberately loose: this passed at ~65 ms and would
         * have taken about eight seconds before, so it is not a benchmark,
         * it is a tripwire for the exponent coming back.
         */
        const payload = `<a ${"x".repeat(1000)}`.repeat(3_200);

        expect(payload.length).toBeGreaterThan(3_000_000);

        const started = Date.now();

        sanitizeHtml(payload);

        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("treats a tag with an absurd attribute run as text, not markup", () => {
        // Past the bound it does not match, so the `<` is escaped — which is
        // the safe direction: visible nonsense rather than invented markup.
        const out = sanitizeHtml(`<a ${"x".repeat(9_000)}>Link</a>`);

        expect(out).not.toContain("<a");
        expect(out).toContain("&lt;a");
    });

    it("does not let a sender's own rel beat the one we append", () => {
        /**
         * A duplicate attribute in HTML is won by the **first** one, and the
         * sanitiser appends its pair at the end — so a mail carrying
         * `rel="opener"` kept it and `noopener` was the one the browser
         * ignored. Neither arrives from the sender any more.
         */
        const out = sanitizeHtml(
            '<a href="https://example.net/" rel="opener" target="_self">Link</a>',
        );

        expect(out).not.toContain('opener"');
        expect(out).not.toContain("_self");

        // Exactly one of each, and ours.
        expect(out.match(/rel=/g)).toHaveLength(1);
        expect(out.match(/target=/g)).toHaveLength(1);
        expect(out).toContain('rel="noopener noreferrer nofollow"');
        expect(out).toContain('target="_blank"');
    });

    it("keeps mailto, tel and cid, which an email needs", () => {
        expect(sanitizeHtml('<a href="mailto:a@x.net">m</a>')).toContain(
            "mailto:a@x.net",
        );
        expect(sanitizeHtml('<img src="cid:logo123">')).toContain(
            "cid:logo123",
        );
    });

    it("allows a data: image and refuses every other data: URL", () => {
        const image = sanitizeHtml(
            '<img src="data:image/png;base64,iVBORw0KGgo=">',
        );

        expect(image).toContain("data:image/png;base64");

        const html = sanitizeHtml(
            '<img src="data:text/html;base64,PHNjcmlwdD4=">',
        );

        expect(html).not.toContain("data:text/html");

        // A data: URL in an href is never useful in a mail and is a known
        // way of getting a document onto the reader's screen.
        const link = sanitizeHtml(
            '<a href="data:image/png;base64,iVBORw0KGgo=">x</a>',
        );

        expect(link).not.toContain("data:");
    });

    it("unwraps an unknown element rather than losing the text in it", () => {
        const out = sanitizeHtml("<marquee>wichtig</marquee>");

        expect(out).toContain("wichtig");
        expect(out).not.toContain("marquee");
    });

    it("removes an iframe, an object and a form with their contents", () => {
        const out = sanitizeHtml(
            '<iframe src="https://evil.test"></iframe>' +
                "<object data=x></object>" +
                '<form action="https://evil.test"><input name="p"></form>' +
                "<p>Rest</p>",
        );

        expect(out).toContain("Rest");
        expect(out).not.toContain("iframe");
        expect(out).not.toContain("evil.test");
        expect(out).not.toContain("<form");
        expect(out).not.toContain("<input");
    });

    it("removes a comment, including one hiding a tag", () => {
        const out = sanitizeHtml("<!-- <script>alert(1)</script> --><p>a</p>");

        expect(out).not.toContain("alert");
        expect(out).toContain("<p>a</p>");
    });

    it("escapes the text between tags, so a stray < cannot open one", () => {
        expect(sanitizeHtml("<p>a < b und c > d</p>")).toBe(
            "<p>a &lt; b und c &gt; d</p>",
        );
    });

    it("keeps the table markup every newsletter is built from", () => {
        const out = sanitizeHtml(
            '<table border="0" cellpadding="8"><tr><td bgcolor="#fff" colspan="2">x</td></tr></table>',
        );

        expect(out).toContain("<table");
        expect(out).toContain('colspan="2"');
        expect(out).toContain('bgcolor="#fff"');
    });

    it("is empty for nothing", () => {
        expect(sanitizeHtml(null)).toBe("");
        expect(sanitizeHtml(undefined)).toBe("");
        expect(sanitizeHtml("")).toBe("");
    });
});

describe("safeUrl", () => {
    it("keeps the schemes a mail uses", () => {
        expect(safeUrl("https://example.net", false)).toBe(
            "https://example.net",
        );
        expect(safeUrl("http://example.net", false)).toBe("http://example.net");
        expect(safeUrl("tel:+4925112345", false)).toBe("tel:+4925112345");
    });

    it("keeps a relative URL, which resolves to nothing in a sandbox", () => {
        expect(safeUrl("/pfad", false)).toBe("/pfad");
    });

    it("refuses anything else", () => {
        expect(safeUrl("file:///etc/passwd", true)).toBeNull();
        expect(safeUrl("ftp://x.net", true)).toBeNull();
        expect(safeUrl("", true)).toBeNull();
    });
});

describe("safeStyle", () => {
    it("keeps the declarations that make a mail readable", () => {
        expect(safeStyle("color: #333; font-size: 14px")).toBe(
            "color:#333;font-size:14px",
        );
    });

    it("drops expression(), url() and @import", () => {
        expect(safeStyle("width: expression(alert(1))")).toBe("");
        expect(safeStyle("background: url(javascript:alert(1))")).toBe("");
        expect(safeStyle("@import url(x.css)")).toBe("");
    });

    it("drops a position that would cover the page around it", () => {
        expect(safeStyle("position: fixed; top: 0")).toBe("top:0");
        expect(safeStyle("position: static")).toBe("position:static");
    });

    it("drops a comment used to hide a declaration", () => {
        expect(safeStyle("color:/* x */ red")).toBe("color:red");
    });
});

describe("htmlToText", () => {
    it("turns block structure into line breaks", () => {
        expect(htmlToText("<p>eins</p><p>zwei</p>")).toBe("eins\nzwei");
        expect(htmlToText("eins<br>zwei")).toBe("eins\nzwei");
    });

    it("decodes the entities an escaped body carries", () => {
        expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toBe(
            'a & b <c> "d"',
        );
    });

    it("drops a style block rather than printing the CSS", () => {
        expect(htmlToText("<style>p{color:red}</style><p>a</p>")).toBe("a");
    });
});
