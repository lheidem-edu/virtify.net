import { randomBytes, randomInt } from "node:crypto";

/**
 * Everything a customer can influence, made into something that is safe to
 * put in a Proxmox parameter.
 *
 * **This is the last line, not the first.** The request body is built by
 * `URLSearchParams` in `./api.ts`, which is what actually keeps a `&` or a
 * newline from becoming a second parameter. What this file does is narrower
 * and more useful: it refuses values that are *wrong* before they are
 * encoded, so a hostname with a semicolon in it is a validation error on the
 * order form rather than a VM called `web;rm`.
 *
 * Why it needs to exist at all: a hostname, an SSH key and a label come off
 * a customer's order form through `product.module_config` and
 * `service.label`, travel through cloud-init into a guest's
 * `/etc/hosts` and `~/.ssh/authorized_keys`, and are rendered back into the
 * panel. Each of those is a different escaping regime, and the only one
 * worth relying on is "the value was never dangerous in the first place".
 */

export class ProvisioningInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProvisioningInputError";
    }
}

/**
 * A DNS label: `[a-z0-9-]`, no leading or trailing hyphen, at most 63 bytes.
 *
 * Everything else is dropped rather than escaped. A customer who types
 * „Mein Server!“ gets `mein-server`, which is what they meant; a customer
 * who types something with no usable characters at all gets the fallback,
 * because an empty hostname is a VM Proxmox will not create and an error the
 * customer cannot act on.
 */
export function toHostLabel(value: string, fallback: string): string {
    const label = value
        /**
         * German first, Unicode normalisation second — and the order is
         * load-bearing. `NFKD` decomposes `ö` into `o` plus a combining
         * diaeresis, after which no rule matching `ö` can ever fire again:
         * „Größter“ came out as `gro-sster` rather than `groesster`,
         * because the ß survived but the ö had already fallen apart.
         */
        .replace(/ä/gi, "ae")
        .replace(/ö/gi, "oe")
        .replace(/ü/gi, "ue")
        .replace(/ß/g, "ss")
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 63)
        // The slice can leave a trailing hyphen behind.
        .replace(/-+$/g, "");

    return label === "" ? fallback : label;
}

/**
 * A fully qualified hostname: labels joined by dots, at most 253 bytes.
 *
 * Proxmox passes this straight to cloud-init, which writes it into the
 * guest's `/etc/hostname`. A dot is the only separator allowed through;
 * anything else in a label is dealt with by `toHostLabel`.
 */
export function toHostname(value: string, fallback: string): string {
    const labels = value
        .split(".")
        .map((part) => toHostLabel(part, ""))
        .filter((part) => part !== "");

    if (labels.length === 0) {
        return toHostLabel(fallback, "vm");
    }

    let name = labels.join(".");

    while (name.length > 253) {
        labels.pop();
        name = labels.join(".");
    }

    return name === "" ? toHostLabel(fallback, "vm") : name;
}

/**
 * An OpenSSH public key, or nothing.
 *
 * Accepts the three algorithms a hoster actually sees and refuses a private
 * key outright — people paste them by accident, and a private key in
 * `authorized_keys` is a key that no longer protects anything. Newlines are
 * refused rather than stripped: a value with two keys in it is a customer
 * who meant to add two keys, and silently keeping one of them is worse than
 * saying so.
 */
const SSH_KEY =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\n\r]{0,200})?$/;

export function parseSshKeys(value: string): string[] {
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));

    const keys: string[] = [];

    for (const line of lines) {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
            throw new ProvisioningInputError(
                "Das ist ein privater Schlüssel. Erwartet wird der öffentliche " +
                    "Teil — die Zeile, die mit `ssh-ed25519` oder `ssh-rsa` beginnt.",
            );
        }

        if (!SSH_KEY.test(line)) {
            throw new ProvisioningInputError(
                `„${line.slice(0, 40)}…“ ist kein öffentlicher SSH-Schlüssel.`,
            );
        }

        if (line.length > 4000) {
            throw new ProvisioningInputError("Der SSH-Schlüssel ist zu lang.");
        }

        keys.push(line);
    }

    if (keys.length > 10) {
        throw new ProvisioningInputError(
            "Höchstens zehn SSH-Schlüssel je Leistung.",
        );
    }

    return keys;
}

const IPV4 =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * An IPv6 address in any of the forms a pool is written in.
 *
 * Deliberately not a full RFC 4291 grammar: this has to say yes to what an
 * operator types into the pool form and no to anything with a comma, a
 * newline or a slash in it, because those are the characters that mean
 * something to `ipconfig0`.
 */
const IPV6 = /^[0-9a-f:]+$/i;

export function isIpv4(value: string): boolean {
    return IPV4.test(value);
}

export function isIpv6(value: string): boolean {
    if (!IPV6.test(value)) {
        return false;
    }

    // At least one colon, no more than one `::`, and at most eight groups.
    if (!value.includes(":")) {
        return false;
    }

    if ((value.match(/::/g) ?? []).length > 1) {
        return false;
    }

    return value.split(":").filter((part) => part !== "").length <= 8;
}

/**
 * One IPv6 address, written one way.
 *
 * `2001:db8::1`, `2001:0db8:0000:0000:0000:0000:0000:0001` and
 * `2001:DB8::0001` are the same address, and the unique index on
 * `(pool_id, address)` compares text — so an operator who pastes a range
 * twice in two notations gets two rows for one address, and the pool hands
 * it to two customers. Node's URL parser implements the WHATWG IPv6
 * serializer, which is the canonical compressed form, and it costs no
 * dependency (rule 12).
 */
export function canonicalIpv6(value: string): string | null {
    try {
        const host = new URL(`http://[${value}]/`).hostname;

        return host.startsWith("[") ? host.slice(1, -1) : host;
    } catch {
        return null;
    }
}

export function assertAddress(
    address: string,
    family: "ipv4" | "ipv6",
): string {
    const value = address.trim().toLowerCase();

    if (family === "ipv4" ? !isIpv4(value) : !isIpv6(value)) {
        throw new ProvisioningInputError(
            `„${address}“ ist keine gültige ${
                family === "ipv4" ? "IPv4" : "IPv6"
            }-Adresse.`,
        );
    }

    if (family === "ipv6") {
        const canonical = canonicalIpv6(value);

        if (!canonical) {
            throw new ProvisioningInputError(
                `„${address}“ ist keine gültige IPv6-Adresse.`,
            );
        }

        return canonical;
    }

    return value;
}

export function assertPrefixLength(
    length: number,
    family: "ipv4" | "ipv6",
): number {
    const max = family === "ipv4" ? 32 : 128;

    if (!Number.isInteger(length) || length < 0 || length > max) {
        throw new ProvisioningInputError(
            `Eine ${family === "ipv4" ? "IPv4" : "IPv6"}-Maske liegt zwischen 0 und ${max}.`,
        );
    }

    return length;
}

export type IpConfigInput = {
    family: "ipv4" | "ipv6";
    address: string;
    prefixLength: number;
    gateway: string | null;
};

/**
 * `ipconfig0` as Proxmox spells it: `ip=1.2.3.4/24,gw=1.2.3.1` and
 * `ip6=2001:db8::2/64,gw6=2001:db8::1`.
 *
 * Every piece is validated first, so the commas and the slash this joins
 * with cannot come from anywhere but here.
 */
export function ipConfigValue(entries: IpConfigInput[]): string {
    const parts: string[] = [];

    for (const entry of entries) {
        const address = assertAddress(entry.address, entry.family);
        const prefix = assertPrefixLength(entry.prefixLength, entry.family);

        if (entry.family === "ipv4") {
            parts.push(`ip=${address}/${prefix}`);

            if (entry.gateway) {
                parts.push(`gw=${assertAddress(entry.gateway, "ipv4")}`);
            }
        } else {
            parts.push(`ip6=${address}/${prefix}`);

            if (entry.gateway) {
                parts.push(`gw6=${assertAddress(entry.gateway, "ipv6")}`);
            }
        }
    }

    return parts.join(",");
}

/** `nameserver` takes a space-separated list, and only addresses. */
export function nameserverValue(values: readonly string[]): string {
    const seen: string[] = [];

    for (const raw of values) {
        const value = raw.trim().toLowerCase();

        if (value === "") {
            continue;
        }

        if (!isIpv4(value) && !isIpv6(value)) {
            throw new ProvisioningInputError(
                `„${raw}“ ist kein gültiger Nameserver.`,
            );
        }

        if (!seen.includes(value)) {
            seen.push(value);
        }
    }

    return seen.slice(0, 3).join(" ");
}

/**
 * A reverse record. The operator types this, not the customer, but it is
 * still a hostname that is rendered back into the panel and handed to a DNS
 * provider later, so it goes through the same gate.
 */
export function toRdns(value: string): string | null {
    const trimmed = value.trim();

    if (trimmed === "") {
        return null;
    }

    const name = toHostname(trimmed, "");

    if (name === "" || !name.includes(".")) {
        throw new ProvisioningInputError(
            "Ein PTR-Eintrag ist ein vollständiger Name, z. B. `vps-17.virtify.net`.",
        );
    }

    return name;
}

/**
 * The initial root password.
 *
 * Generated here and never taken from a form: a password that reached us
 * from the browser is a password that was in a request log. 24 characters
 * out of an alphabet with no look-alikes, which is what a person has to
 * read off the panel once and paste into an SSH session.
 */
const PASSWORD_ALPHABET =
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 24): string {
    let out = "";

    for (let index = 0; index < length; index += 1) {
        out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }

    return out;
}

/** A short, stable suffix for a generated hostname. */
export function hostSuffix(): string {
    return randomBytes(3).toString("hex");
}

/**
 * A positive integer, inside the bounds the module published.
 *
 * Cores and memory come off a config option the customer chose, so they are
 * a number from a form however much the form said it was a dropdown.
 */
export function assertUnits(
    value: unknown,
    label: string,
    bounds: { min: number; max: number },
): number {
    const number = typeof value === "number" ? value : Number(value);

    if (
        !Number.isInteger(number) ||
        number < bounds.min ||
        number > bounds.max
    ) {
        throw new ProvisioningInputError(
            `${label} muss eine ganze Zahl zwischen ${bounds.min} und ${bounds.max} sein.`,
        );
    }

    return number;
}
