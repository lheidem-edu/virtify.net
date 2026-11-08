import { describe, expect, it } from "vitest";
import {
    prepareBody,
    stripQuotedHtml,
    stripQuotedText,
} from "@/server/tickets/quoting";

/**
 * Taking the quoted history off a reply — for display only.
 *
 * Every rule is a guess about somebody else's mail client, so the two
 * properties worth pinning are: it cuts where the client actually put the
 * marker, and **it never leaves the message empty**. A reply that is one
 * line under a quote is the common case; an empty message in the queue is
 * how a customer's question gets missed.
 */

describe("stripQuotedText", () => {
    it("cuts at Outlook's German attribution block", () => {
        const result = stripQuotedText(
            [
                "Danke, das hat geholfen.",
                "",
                "Von: Support <support@example.net>",
                "Gesendet: Montag, 3. November 2026 09:12",
                "An: Maria <maria@example.net>",
                "Betreff: [TKT-00042] Server down",
                "",
                "Guten Tag, ...",
            ].join("\n"),
        );

        expect(result.text).toBe("Danke, das hat geholfen.");
        expect(result.strippedQuote).toBe(true);
    });

    it("cuts at Outlook's -----Ursprüngliche Nachricht----- rule", () => {
        const result = stripQuotedText(
            "Passt.\n\n-----Ursprüngliche Nachricht-----\nVon: x",
        );

        expect(result.text).toBe("Passt.");
    });

    it("cuts at Gmail's attribution line, German and English", () => {
        expect(
            stripQuotedText(
                "Stimmt.\n\nAm Mo., 3. Nov. 2026 um 09:12 Uhr schrieb Support <support@example.net>:\n> alt",
            ).text,
        ).toBe("Stimmt.");

        expect(
            stripQuotedText(
                "Right.\n\nOn Mon, 3 Nov 2026 at 09:12, Support <support@example.net> wrote:\n> old",
            ).text,
        ).toBe("Right.");
    });

    it("cuts at a run of > quoting that reaches the end", () => {
        const result = stripQuotedText(
            "Neue Frage.\n\n> alte Zeile\n> noch eine\n",
        );

        expect(result.text).toBe("Neue Frage.");
        expect(result.strippedQuote).toBe(true);
    });

    it("keeps interleaved quoting, which is an answer and not a history", () => {
        const input = [
            "> Soll der Server neu starten?",
            "Ja, bitte.",
            "> Wann?",
            "Heute Abend.",
        ].join("\n");

        const result = stripQuotedText(input);

        expect(result.text).toBe(input);
        expect(result.strippedQuote).toBe(false);
    });

    it("cuts the signature at the RFC 3676 delimiter", () => {
        const result = stripQuotedText(
            "Danke!\n\n-- \nMaria Musterfrau\nBeispiel GmbH",
        );

        expect(result.text).toBe("Danke!");
        expect(result.strippedSignature).toBe(true);
    });

    it("does not treat an em-dash rule as a signature", () => {
        const result = stripQuotedText("Danke!\n\n---\nnoch etwas");

        expect(result.text).toContain("noch etwas");
    });

    it("keeps the whole message when stripping would empty it", () => {
        const input = "Von: Support <support@example.net>\nBetreff: x\n\nalt";
        const result = stripQuotedText(input);

        expect(result.text).toBe(input);
        expect(result.strippedQuote).toBe(false);
    });

    it("keeps a message that is nothing but a signature", () => {
        const input = "-- \nMaria";

        expect(stripQuotedText(input).text).toBe(input);
    });
});

describe("stripQuotedHtml", () => {
    it("cuts at Gmail's quote container", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><div class="gmail_quote">alt</div>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
        expect(result.strippedQuote).toBe(true);
    });

    it("cuts at Outlook Web's appendonsend marker", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><div id="appendonsend"></div><hr><div>alt</div>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
    });

    it("cuts at Apple Mail's cited blockquote", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><blockquote type="cite">alt</blockquote>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
    });

    it("cuts at our own quote marker", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><div data-virtify-quote="1">alt</div>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
    });

    it("cuts at the earliest marker when a client emits two", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><div class="gmail_quote">a</div><blockquote type="cite">b</blockquote>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
    });

    it("keeps the whole body when the cut would empty it", () => {
        const input = '<blockquote type="cite">nur Zitat</blockquote>';

        expect(stripQuotedHtml(input).html).toBe(input);
    });

    it("cuts a Gmail signature block", () => {
        const result = stripQuotedHtml(
            '<div>Danke.</div><div class="gmail_signature">Maria</div>',
        );

        expect(result.html).toBe("<div>Danke.</div>");
        expect(result.strippedSignature).toBe(true);
    });
});

describe("prepareBody", () => {
    it("sanitises before it strips, so hidden markup cannot steer the cut", () => {
        const prepared = prepareBody({
            html: '<div>Antwort</div><script>x</script><div class="gmail_quote">alt</div>',
            text: null,
        });

        expect(prepared.originalHtml).not.toContain("script");
        expect(prepared.displayHtml).toBe("<div>Antwort</div>");
        expect(prepared.displayText).toBe("Antwort");
    });

    it("keeps the original whole even when the display copy is cut", () => {
        const prepared = prepareBody({
            html: '<div>Antwort</div><div class="gmail_quote">die ganze Vorgeschichte</div>',
            text: null,
        });

        expect(prepared.originalHtml).toContain("die ganze Vorgeschichte");
        expect(prepared.displayHtml).not.toContain("die ganze Vorgeschichte");
        expect(prepared.stripped).toBe(true);
    });

    it("falls back to the text part when there is no HTML", () => {
        const prepared = prepareBody({
            html: null,
            text: "Danke.\n\n-- \nMaria",
        });

        expect(prepared.originalHtml).toBeNull();
        expect(prepared.displayText).toBe("Danke.");
        expect(prepared.originalText).toBe("Danke.\n\n-- \nMaria");
    });

    it("derives a text rendering when the mail was HTML only", () => {
        const prepared = prepareBody({
            html: "<p>Zeile eins</p><p>Zeile zwei</p>",
            text: null,
        });

        expect(prepared.originalText).toBe("Zeile eins\nZeile zwei");
    });
});

/**
 * The markers have to survive the sanitiser, because the sanitiser runs
 * first. Four of these are carried on attributes that an allowlist would
 * drop by default — `id` and `type` and our own `data-` marker — and
 * dropping them meant an Outlook or Apple Mail reply arrived with the whole
 * thread underneath it, re-quoted on every round trip.
 */
describe("prepareBody strips what the real clients send", () => {
    const CLIENTS: { name: string; html: string }[] = [
        {
            name: "Outlook desktop",
            html: '<p>Passt, danke!</p><div id="divRplyFwdMsg"><hr><b>Von:</b> Support<br>Seit heute Morgen ist der Server weg.</div>',
        },
        {
            name: "Outlook Web",
            html: '<p>Passt, danke!</p><div id="appendonsend"></div><div>Seit heute Morgen ist der Server weg.</div>',
        },
        {
            name: "Apple Mail",
            html: '<p>Passt, danke!</p><blockquote type="cite"><div>Seit heute Morgen ist der Server weg.</div></blockquote>',
        },
        {
            name: "Gmail",
            html: '<p>Passt, danke!</p><div class="gmail_quote"><div>Seit heute Morgen ist der Server weg.</div></div>',
        },
        {
            name: "Thunderbird",
            html: '<p>Passt, danke!</p><div class="moz-cite-prefix">Am 08.11.26 schrieb Support:</div><blockquote>Seit heute Morgen ist der Server weg.</blockquote>',
        },
        {
            name: "our own reply, quoted back",
            html: '<p>Passt, danke!</p><div data-virtify-quote="1"><p>Am 8.11. schrieb Support:</p><div>Seit heute Morgen ist der Server weg.</div></div>',
        },
    ];

    for (const client of CLIENTS) {
        it(`cuts the quote a ${client.name} reply carries`, () => {
            const prepared = prepareBody({ html: client.html, text: null });

            expect(prepared.stripped).toBe(true);
            expect(prepared.displayText).toBe("Passt, danke!");
            // The whole thing is still kept, which is what the operator
            // gets back from "Original mit Verlauf anzeigen".
            expect(prepared.originalText).toContain("Server weg");
        });
    }

    it("keeps an id out that is not one of the three markers", () => {
        const prepared = prepareBody({
            html: '<p id="beliebig">Hallo</p>',
            text: null,
        });

        // `id` is a DOM clobbering primitive, so the vocabulary is fixed.
        expect(prepared.originalHtml).not.toContain("beliebig");
        expect(prepared.originalHtml).toContain("Hallo");
    });

    it("does not let a sender choose what our own marker says", () => {
        const prepared = prepareBody({
            html: '<div data-virtify-quote="nein">Hallo</div>',
            text: null,
        });

        expect(prepared.originalHtml).toContain('data-virtify-quote="1"');
        expect(prepared.originalHtml).not.toContain("nein");
    });

    it("keeps `type` only as `cite`", () => {
        const prepared = prepareBody({
            html: '<blockquote type="irgendwas">Hallo</blockquote>',
            text: null,
        });

        expect(prepared.originalHtml).not.toContain("irgendwas");
    });
});
