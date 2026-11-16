import "server-only";
import { loadSettings } from "@/server/settings";

/**
 * The transactional mail layout, and the helpers around it.
 *
 * How a mail actually leaves the building moved to `./transport.ts` in
 * Phase 7: there are two ways out now (an SMTP relay and Microsoft Graph)
 * and every call site asks for "the transport" rather than for nodemailer.
 * The two names are re-exported here so `@/server/mail` stays the one
 * import a mail-sending module needs.
 */

export {
    type EmailLayoutOptions,
    type EmailRow,
    escapeHtml,
    renderEmail,
    renderEmailWith,
} from "./layout";
export {
    addressList,
    ehloName,
    type MailAttachment,
    type MailMessage,
    type MailTransport,
    mailTransport,
    type SentMail,
    smtpTransport,
} from "./transport";

/** Logs a send failure with the relay's own response, which names the cause. */
export function logMailError(context: string, error: unknown) {
    const detail = error as {
        message?: string;
        code?: string;
        responseCode?: number;
        response?: string;
    };

    console.error(
        `[mail] ${context} failed:`,
        JSON.stringify({
            message: detail?.message,
            code: detail?.code,
            responseCode: detail?.responseCode,
            response: detail?.response,
        }),
    );
}

/**
 * Every outbound mail is sent from, and delivered to, the operator address.
 * A function rather than a constant because the address is editable now: a
 * module-level copy would keep the old one until the next deployment.
 */
export async function mailFrom() {
    const { operator } = await loadSettings();
    return operator.email;
}
