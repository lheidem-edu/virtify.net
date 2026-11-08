import { describe, expect, it } from "vitest";
import {
    autoResponseSuppressed,
    autoSubmitted,
    classifyInbound,
    isAutomated,
    isBounce,
} from "@/server/tickets/loop";
import { inboundMessage } from "../helpers/graph";

/**
 * Loop protection.
 *
 * A ticket system that mails back whatever it is mailed, into a mailbox that
 * receives its own outbound copies, generates its own input. Phase 6 shipped
 * the billing version of this; these cases are the mail version.
 */

const OWN = ["support@example.net", "rechnung@example.net"];

function verdict(message = inboundMessage(), own = OWN, isOwn = false) {
    return classifyInbound(message, {
        ownAddresses: own,
        isOwnOutbound: isOwn,
    });
}

describe("what may become a ticket message", () => {
    it("accepts an ordinary mail from a person", () => {
        const result = verdict();

        expect(result.kind).toBe("accept");
        expect(result.automated).toBe(false);
    });

    it("refuses our own outbound copy on the Message-ID we recorded", () => {
        const result = verdict(inboundMessage(), OWN, true);

        expect(result).toEqual({
            kind: "ignore",
            reason: "own-outbound",
            automated: false,
        });
    });

    it("refuses anything sent from one of our own mailboxes", () => {
        const result = verdict(
            inboundMessage({
                from: { email: "Support@Example.NET", name: "Support" },
            }),
        );

        expect(result.kind).toBe("ignore");
        expect(result).toMatchObject({ reason: "own-mailbox" });
    });

    it("checks the envelope sender too, not only From", () => {
        const result = verdict(
            inboundMessage({
                from: { email: "maria@example.net" },
                sender: { email: "rechnung@example.net" },
            }),
        );

        expect(result).toMatchObject({ reason: "own-mailbox" });
    });

    it("refuses a draft sitting in the mailbox", () => {
        expect(verdict(inboundMessage({ isDraft: true }))).toMatchObject({
            reason: "draft",
        });
    });

    it("refuses a message with no sender at all", () => {
        expect(
            verdict(inboundMessage({ from: null, sender: null })),
        ).toMatchObject({ reason: "no-sender" });
    });

    it("files an out-of-office and never calls it a person's message", () => {
        /**
         * The two decisions this module keeps apart. Automatic is a reason
         * not to *answer* — `handleMessage` asks `automated` before it sends
         * an acknowledgement — and never a reason not to listen: in a
         * hosting mailbox the automatic mail is often a customer's
         * monitoring saying a machine is down.
         */
        expect(
            verdict(
                inboundMessage({
                    headers: { "x-auto-response-suppress": "All" },
                }),
            ),
        ).toEqual({ kind: "accept", automated: true });
    });

    it("marks anything Auto-Submitted that is not `no` as automated", () => {
        for (const value of [
            "auto-generated",
            "auto-replied",
            "auto-notified",
            "AUTO-GENERATED",
            "auto-generated; owner-email=x@y.net",
            // Two relays, two headers, joined with a comma by the channel.
            "no, auto-generated",
        ]) {
            expect(
                verdict(
                    inboundMessage({ headers: { "auto-submitted": value } }),
                ),
            ).toEqual({ kind: "accept", automated: true });
        }
    });

    it("is not fooled into automated by a header repeated as `no`", () => {
        // `no, no` read as one string is not `no`, and a message two mail
        // servers both called human must not come out as a machine's.
        expect(
            verdict(
                inboundMessage({ headers: { "auto-submitted": "no, no" } }),
            ),
        ).toEqual({ kind: "accept", automated: false });
    });

    it("accepts Auto-Submitted: no, which RFC 3834 says a person sent", () => {
        expect(
            verdict(inboundMessage({ headers: { "auto-submitted": "no" } })),
        ).toMatchObject({ kind: "accept" });
    });

    it("refuses a bounce by every signal, and never files it", () => {
        const byReturnPath = verdict(
            inboundMessage({ headers: { "return-path": "<>" } }),
        );
        const byContentType = verdict(
            inboundMessage({
                headers: {
                    "content-type":
                        'multipart/report; report-type=delivery-status; boundary="x"',
                },
            }),
        );
        const byFailedRecipients = verdict(
            inboundMessage({
                headers: { "x-failed-recipients": "weg@example.net" },
            }),
        );
        // `postmaster@` alone is a person — see the test below — so the
        // bounce case is the one that also carries a machine's marker.
        const byPostmaster = verdict(
            inboundMessage({
                from: { email: "postmaster@example.org" },
                headers: { "auto-submitted": "auto-replied" },
            }),
        );
        const byExchange = verdict(
            inboundMessage({
                from: {
                    email: "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@example.org",
                },
            }),
        );

        for (const result of [
            byReturnPath,
            byContentType,
            byFailedRecipients,
            byPostmaster,
            byExchange,
        ]) {
            expect(result).toEqual({
                kind: "ignore",
                reason: "bounce",
                automated: true,
            });
        }
    });

    it("files mail from a customer's postmaster@, which is a person", () => {
        /**
         * RFC 2142 makes every domain have one, and in a hosting company's
         * mailbox it is an address customers write from — about mail, which
         * is the subject least likely to survive being dropped in silence.
         */
        expect(
            verdict(
                inboundMessage({
                    from: { email: "postmaster@kundendomain.de" },
                    subject: "Unsere Mails kommen nicht an",
                }),
            ),
        ).toEqual({ kind: "accept", automated: false });

        // mailer-daemon@ is never a person, and still is not.
        expect(
            verdict(
                inboundMessage({
                    from: { email: "mailer-daemon@example.org" },
                }),
            ),
        ).toEqual({ kind: "ignore", reason: "bounce", automated: true });
    });

    it("does not mistake a plain multipart/report for a bounce", () => {
        // `report-type` is what makes it a DSN. Without it this is an
        // ordinary structured attachment.
        expect(
            verdict(
                inboundMessage({
                    headers: {
                        "content-type": 'multipart/report; boundary="x"',
                    },
                }),
            ),
        ).toMatchObject({ kind: "accept" });
    });

    it("prefers our own copy over every other reason", () => {
        // A copy of our own automatic acknowledgement coming back: both
        // apply, and the one that names what it actually is wins.
        const result = verdict(
            inboundMessage({ headers: { "auto-submitted": "auto-generated" } }),
            OWN,
            true,
        );

        expect(result).toMatchObject({ reason: "own-outbound" });
    });
});

describe("what may be answered automatically", () => {
    it("is false for a mailing list", () => {
        expect(
            isAutomated(inboundMessage({ headers: { precedence: "bulk" } })),
        ).toBe(true);
        expect(
            isAutomated(inboundMessage({ headers: { precedence: "list" } })),
        ).toBe(true);
        expect(
            isAutomated(
                inboundMessage({
                    headers: { "list-unsubscribe": "<mailto:x@y.net>" },
                }),
            ),
        ).toBe(true);
    });

    it("is true for an ordinary mail", () => {
        expect(isAutomated(inboundMessage())).toBe(false);
    });
});

describe("the header readers on their own", () => {
    it("autoSubmitted ignores the parameters after the semicolon", () => {
        expect(
            autoSubmitted(
                inboundMessage({
                    headers: { "auto-submitted": "no; owner-email=x@y.net" },
                }),
            ),
        ).toBe(false);
    });

    it("autoResponseSuppressed treats any non-empty value as a request", () => {
        expect(
            autoResponseSuppressed(
                inboundMessage({
                    headers: { "x-auto-response-suppress": "OOF, AutoReply" },
                }),
            ),
        ).toBe(true);

        expect(
            autoResponseSuppressed(
                inboundMessage({ headers: { "x-auto-response-suppress": "" } }),
            ),
        ).toBe(false);
    });

    it("isBounce leaves an ordinary Return-Path alone", () => {
        expect(
            isBounce(
                inboundMessage({
                    headers: { "return-path": "<maria@example.net>" },
                }),
            ),
        ).toBe(false);
    });
});
