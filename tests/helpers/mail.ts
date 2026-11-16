import type {
    MailMessage,
    MailTransport,
    SentMail,
} from "@/server/mail/transport";

/**
 * A transport that keeps what it was handed.
 *
 * There is no SMTP relay and no Microsoft 365 tenant for this installation,
 * and none is to be gone looking for — so the only honest way to test the
 * outbox is a fake that answers in the shapes a real one does, including the
 * awkward ones.
 *
 * **A fake that makes the code's assumption true by construction tests
 * nothing**, which is how Phase 7's 204-vs-202 defect and Phase 8's
 * "already gone" defect both survived their own suites. So this one can be
 * told to:
 *
 *  - **report no Message-ID.** Microsoft Graph's `sendMail` answers `202
 *    Accepted` with an empty body and no id at all, and nodemailer's id for a
 *    relay that returns a bare `250 OK` is whatever nodemailer made up. Code
 *    that keyed anything on the id being there would break here.
 *  - **throw.** The send failed and the message did not go out; the row gets
 *    an attempt and a backoff.
 *  - **succeed and then make the recording fail**, which the caller arranges
 *    by breaking the connection — the one case that must *not* be retried.
 */
export type FakeTransport = MailTransport & {
    sent: MailMessage[];
    /** Set to make the next `sendMail` throw with this message. */
    failWith: string | null;
    /** Set to answer without a Message-ID, as Graph does. */
    reportNoMessageId: boolean;
    /** Runs after a successful send, before the caller records it. */
    afterSend: (() => Promise<void>) | null;
};

export function fakeTransport(id: "smtp" | "graph" = "smtp"): FakeTransport {
    const transport: FakeTransport = {
        id,
        sent: [],
        failWith: null,
        reportNoMessageId: false,
        afterSend: null,
        async sendMail(message: MailMessage): Promise<SentMail> {
            if (transport.failWith) {
                const reason = transport.failWith;
                transport.failWith = null;

                throw new Error(reason);
            }

            transport.sent.push(message);

            if (transport.afterSend) {
                const hook = transport.afterSend;
                transport.afterSend = null;
                await hook();
            }

            return {
                messageId: transport.reportNoMessageId
                    ? null
                    : `<${transport.sent.length}@virtify.test>`,
            };
        },
    };

    return transport;
}
