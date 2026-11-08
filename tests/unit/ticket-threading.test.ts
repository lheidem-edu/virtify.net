import { describe, expect, it } from "vitest";
import {
    baseSubject,
    normalizeMessageId,
    parseMessageIds,
} from "@/server/tickets/headers";
import {
    formatTicketNumber,
    parseTicketNumber,
    subjectWithTag,
    ticketTag,
} from "@/server/tickets/numbering";

/**
 * The threading signals, read off a subject line and a header.
 *
 * Every case here is a real shape a mail client emits. The ones that matter
 * most are the refusals: a tag this reads too generously joins two
 * customers' conversations, which is the worst thing ticketing can do.
 */

describe("the ticket number in a subject", () => {
    it("is found wherever a client has put it", () => {
        expect(parseTicketNumber("[TKT-00042] Server down")).toBe(42);
        expect(parseTicketNumber("Re: [TKT-00042] Server down")).toBe(42);
        expect(parseTicketNumber("AW: Re: [TKT-00042] Server down")).toBe(42);
        expect(parseTicketNumber("Server down [TKT-00042]")).toBe(42);
        expect(parseTicketNumber("[tkt-00042] server down")).toBe(42);
        // Some clients eat the hyphen; some insert spaces.
        expect(parseTicketNumber("[TKT 00042] x")).toBe(42);
        expect(parseTicketNumber("[ TKT-42 ] x")).toBe(42);
    });

    it("refuses everything that is not one", () => {
        expect(parseTicketNumber("Server down")).toBeNull();
        expect(parseTicketNumber(null)).toBeNull();
        expect(parseTicketNumber("")).toBeNull();
        // No brackets: a sentence mentioning a ticket is not a reply to one.
        expect(parseTicketNumber("betrifft TKT-00042")).toBeNull();
        // A different tag entirely.
        expect(parseTicketNumber("[RE-2026-0042] Rechnung")).toBeNull();
        // Zero is not a ticket; the counter starts at 1.
        expect(parseTicketNumber("[TKT-00000] x")).toBeNull();
        // Ten digits is somebody's order id pasted into a bracket.
        expect(parseTicketNumber("[TKT-1234567890] x")).toBeNull();
    });

    it("round-trips through the tag it writes", () => {
        for (const value of [1, 42, 99_999, 123_456]) {
            expect(parseTicketNumber(ticketTag(value))).toBe(value);
        }
    });

    it("pads to five and does not truncate beyond it", () => {
        expect(formatTicketNumber(42)).toBe("TKT-00042");
        expect(formatTicketNumber(123_456)).toBe("TKT-123456");
    });

    it("adds the tag once, however often the subject is re-sent", () => {
        const first = subjectWithTag(42, "Server down");

        expect(first).toBe("[TKT-00042] Server down");
        expect(subjectWithTag(42, first)).toBe(first);
        expect(subjectWithTag(42, "Re: [TKT-00042] Server down")).toBe(
            "Re: [TKT-00042] Server down",
        );
    });
});

describe("In-Reply-To and References", () => {
    it("keeps the angle brackets, because Message-ID arrives with them", () => {
        expect(parseMessageIds("<abc@example.net>")).toEqual([
            "<abc@example.net>",
        ]);
    });

    it("splits a References chain however it was separated", () => {
        expect(parseMessageIds("<a@x.net> <b@x.net>\r\n\t<c@x.net>")).toEqual([
            "<a@x.net>",
            "<b@x.net>",
            "<c@x.net>",
        ]);

        // Some mailers comma-separate, which RFC 5322 does not ask for.
        expect(parseMessageIds("<a@x.net>, <b@x.net>")).toEqual([
            "<a@x.net>",
            "<b@x.net>",
        ]);
    });

    it("drops repeats, so a long thread is not looked up ten times", () => {
        expect(parseMessageIds("<a@x.net> <a@x.net> <b@x.net>")).toEqual([
            "<a@x.net>",
            "<b@x.net>",
        ]);
    });

    it("takes a bare id only when it is the whole header", () => {
        expect(parseMessageIds("abc@example.net")).toEqual([
            "<abc@example.net>",
        ]);
        // Two bare ids are ambiguous — a local part may contain anything.
        expect(parseMessageIds("abc@example.net def@example.net")).toEqual([]);
    });

    it("is empty for nothing", () => {
        expect(parseMessageIds(null)).toEqual([]);
        expect(parseMessageIds("")).toEqual([]);
        expect(parseMessageIds("   ")).toEqual([]);
    });

    it("normalises a Message-ID to the form it is compared in", () => {
        expect(normalizeMessageId("abc@x.net")).toBe("<abc@x.net>");
        expect(normalizeMessageId("<abc@x.net>")).toBe("<abc@x.net>");
        expect(normalizeMessageId("  <abc@x.net>  ")).toBe("<abc@x.net>");
        expect(normalizeMessageId("")).toBeNull();
        expect(normalizeMessageId(null)).toBeNull();
    });
});

describe("the subject without its prefixes", () => {
    it("strips every language's reply marker, however they are stacked", () => {
        expect(baseSubject("Re: Server down")).toBe("Server down");
        expect(baseSubject("AW: Server down")).toBe("Server down");
        expect(baseSubject("Antwort: Server down")).toBe("Server down");
        expect(baseSubject("WG: Fwd: Re: Server down")).toBe("Server down");
        expect(baseSubject("Re[2]: Server down")).toBe("Server down");
    });

    it("leaves a subject that only looks like one alone", () => {
        expect(baseSubject("Reboot: nötig?")).toBe("Reboot: nötig?");
        expect(baseSubject("Server down")).toBe("Server down");
    });

    it("terminates on a subject made of nothing but prefixes", () => {
        expect(baseSubject("Re: Re: Re: Re: Re: Re: Re: Re: Re: Re: Re:")).toBe(
            "",
        );
    });
});
