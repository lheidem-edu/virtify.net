import "server-only";
import nodemailer from "nodemailer";
import { operator } from "@/lib/site";

/**
 * Mail relay used for outbound notifications. The relay is reached on port 25
 * without authentication, so it is expected to be an internal host that
 * accepts mail from this server by address. Certificate validation is relaxed
 * because such relays commonly present an internal or self-signed
 * certificate — set this back to strict once the relay has a trusted one.
 */
export function createTransport() {
    const host = process.env.VIRTIFY_SMTP_HOST;

    if (!host) {
        return null;
    }

    return nodemailer.createTransport({
        host,
        port: 25,
        secure: false,
        auth: undefined,
        tls: { rejectUnauthorized: false },
    });
}

/** Every outbound mail is sent from, and delivered to, the operator address. */
export const mailFrom = operator.email;
