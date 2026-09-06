#!/usr/bin/env node
import { lookup } from "node:dns/promises";
/**
 * Diagnoses the outbound mail path the cancellation form uses.
 *
 *   VIRTIFY_SMTP_HOST=relay.example.net npm run mail:check -- you@example.com
 *
 * Prints the resolved configuration, verifies the connection, then sends one
 * test message. Any SMTP error is printed in full, including the response
 * code the relay gave.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nodemailer = require("nodemailer");

const host = process.env.VIRTIFY_SMTP_HOST;
const to = process.argv[2] ?? "admin@virtify.net";
const from = "admin@virtify.net";

/** Turns the responses this setup actually produces into plain advice. */
function explain(response) {
    if (response.includes("4.4.62")) {
        return [
            "  This endpoint does not serve the recipient's domain.",
            "",
            "  A *.mail.protection.outlook.com / *.mx.microsoft host is one",
            "  tenant's inbound MX. It accepts mail only for recipients in that",
            "  tenant and will not relay anywhere else — so it cannot be used as",
            "  a general outbound relay.",
            "",
            "  Check the recipient domain's MX and compare:",
            "    dig +short MX <recipient-domain>",
            "",
            "  For outbound mail to arbitrary customers, point VIRTIFY_SMTP_HOST",
            "  at your own relay instead.",
            "",
        ].join("\n");
    }

    if (response.includes("4.7.25")) {
        return [
            "  The sending IP has no reverse DNS (PTR) record.",
            "",
            "  Microsoft rejects mail from addresses without one. If the address",
            "  in the message above is IPv6, the quickest fix is usually to give",
            "  the relay a PTR record; forcing IPv4 also avoids it.",
            "",
        ].join("\n");
    }

    if (response.includes("5.7.1") || response.includes("550")) {
        return [
            "  The relay will not accept this sender or this recipient.",
            "",
            "  Allow this server's IP on the relay, and make sure the sending",
            "  IP is covered by the SPF record of the From domain.",
            "",
        ].join("\n");
    }

    return "  See the response above for the reason the relay gave.\n";
}

function line(label, value) {
    console.log(`  ${label.padEnd(22)} ${value}`);
}

console.log("\nvirtify.net mail check\n");

if (!host) {
    console.error("  VIRTIFY_SMTP_HOST is not set.\n");
    console.error("  The app falls back to showing the declaration on screen");
    console.error(
        "  and sends nothing. Set it where the server actually runs:",
    );
    console.error("    - .env.local for `next dev` / `next start`");
    console.error("    - the unit's Environment= for systemd");
    console.error("    - the container's env for Docker/Compose\n");
    process.exit(1);
}

line("VIRTIFY_SMTP_HOST", host);
line("port", "25 (fixed)");
line("address family", "IPv4 (forced)");
line("auth", "none (fixed)");
line("from / envelope", from);
line("test recipient", to);

try {
    const resolved = await lookup(host, { all: true });
    line("resolves to", resolved.map((entry) => entry.address).join(", "));
} catch (error) {
    console.log(`\n  DNS lookup for ${host} failed: ${error.message}`);
    console.log(
        "  The relay host name cannot be resolved from this machine.\n",
    );
    process.exit(1);
}

const transport = nodemailer.createTransport({
    host,
    port: 25,
    secure: false,
    auth: undefined,
    tls: { rejectUnauthorized: false },
    // Mirrors the app's transport — see the note in src/lib/mail.ts.
    family: 4,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: true,
    debug: true,
});

console.log("\n--- connecting ---\n");

try {
    await transport.verify();
    console.log("\n  connection and handshake OK\n");
} catch (error) {
    console.error("\n  connection failed\n");
    console.error(`  ${error.message}`);
    if (error.code) line("code", error.code);
    if (error.responseCode) line("responseCode", error.responseCode);
    if (error.response) line("response", error.response);
    console.error(
        "\n  Common causes: the relay is not reachable from this host, it is\n" +
            "  not listening on port 25, or a firewall drops outbound 25.\n",
    );
    process.exit(1);
}

console.log("--- sending test message ---\n");

try {
    const info = await transport.sendMail({
        from,
        to,
        subject: "virtify.net — SMTP-Test",
        text: "Wenn diese Nachricht ankommt, funktioniert der Mailversand.",
        html: "<p>Wenn diese Nachricht ankommt, funktioniert der Mailversand.</p>",
    });

    console.log("\n  accepted by the relay\n");
    line("messageId", info.messageId);
    line("accepted", JSON.stringify(info.accepted));
    line("rejected", JSON.stringify(info.rejected));
    line("response", info.response);
    console.log(
        "\n  The relay took the message. If it still does not arrive, the\n" +
            "  problem is downstream: relaying rules, SPF/DKIM, or the spam folder.\n",
    );
} catch (error) {
    console.error("\n  the relay refused the message\n");
    console.error(`  ${error.message}`);
    if (error.code) line("code", error.code);
    if (error.responseCode) line("responseCode", error.responseCode);
    if (error.response) line("response", error.response);
    console.error(`\n${explain(String(error.response ?? error.message))}`);
    process.exit(1);
}
