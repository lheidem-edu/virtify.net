import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";

/**
 * Symmetric encryption for the secrets this panel has to keep usable rather
 * than merely verify: gateway credentials, server API tokens, Graph secrets,
 * service passwords. Passwords of our own users are hashed by Better Auth and
 * never go through here.
 *
 * Stored form: `v1.<key id>.<iv>.<ciphertext><tag>`, all base64url. The key id
 * is a fingerprint of the key that encrypted the value, so a rotation can keep
 * reading old rows while writing new ones with the new key.
 */

const SCHEME = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptionKey = {
    /** Short fingerprint, stored in the ciphertext to pick the key again. */
    id: string;
    material: Buffer;
};

function fingerprint(material: Buffer): string {
    return createHash("sha256")
        .update("virtify-key-id")
        .update(material)
        .digest("base64url")
        .slice(0, 8);
}

/**
 * Accepts base64, base64url or hex, so whatever `openssl rand` printed can be
 * pasted straight into the environment.
 */
export function parseKey(value: string): EncryptionKey {
    const trimmed = value.trim();
    const material = /^[0-9a-f]{64}$/i.test(trimmed)
        ? Buffer.from(trimmed, "hex")
        : Buffer.from(trimmed, "base64");

    if (material.length !== KEY_BYTES) {
        throw new Error(
            `An encryption key must be ${KEY_BYTES} bytes; got ${material.length}. Generate one with \`openssl rand -base64 32\`.`,
        );
    }

    return { id: fingerprint(material), material };
}

export function generateKey(): string {
    return randomBytes(KEY_BYTES).toString("base64");
}

let keyring: EncryptionKey[] | null = null;

/**
 * The first key encrypts; every key decrypts. `APP_ENCRYPTION_KEY_OLD` holds
 * the retired keys during a rotation, comma-separated.
 */
function loadKeyring(): EncryptionKey[] {
    if (keyring) {
        return keyring;
    }

    const primary = process.env.APP_ENCRYPTION_KEY;

    if (!primary) {
        throw new Error(
            "APP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and put it in .env.local.",
        );
    }

    const retired = (process.env.APP_ENCRYPTION_KEY_OLD ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .map(parseKey);

    keyring = [parseKey(primary), ...retired];

    return keyring;
}

/** Only for tests and for a rotation script that supplies its own keys. */
export function setKeyring(keys: (string | EncryptionKey)[]): void {
    if (keys.length === 0) {
        throw new Error("A keyring needs at least one key");
    }

    keyring = keys.map((key) =>
        typeof key === "string" ? parseKey(key) : key,
    );
}

export function resetKeyring(): void {
    keyring = null;
}

/**
 * `context` is authenticated but not encrypted. Pass a stable label such as
 * `"mailbox.client_secret"`, and a value lifted out of one column cannot be
 * replayed into another.
 */
export function encrypt(plaintext: string, context = ""): string {
    const [key] = loadKeyring();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key.material, iv, {
        authTagLength: TAG_BYTES,
    });

    cipher.setAAD(Buffer.from(`${SCHEME}:${context}`, "utf8"));

    const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
    ]);

    return [
        SCHEME,
        key.id,
        iv.toString("base64url"),
        body.toString("base64url"),
    ].join(".");
}

export function isEncrypted(value: string): boolean {
    const parts = value.split(".");

    return parts.length === 4 && parts[0] === SCHEME;
}

export type Decrypted = {
    plaintext: string;
    /** True when an old key opened it, so the row should be re-encrypted. */
    staleKey: boolean;
};

export function decryptWithMeta(stored: string, context = ""): Decrypted {
    const parts = stored.split(".");

    if (parts.length !== 4 || parts[0] !== SCHEME) {
        throw new Error("Not an encrypted value, or an unknown scheme");
    }

    const [, keyId, ivPart, bodyPart] = parts;
    const ring = loadKeyring();
    const candidates = ring.filter((key) =>
        timingSafeEqualString(key.id, keyId),
    );
    // An unrecognised fingerprint still gets every key tried: the id is a
    // hint for speed, not a security boundary, and it may predate a rotation.
    const attempts = candidates.length > 0 ? candidates : ring;

    const iv = Buffer.from(ivPart, "base64url");
    const body = Buffer.from(bodyPart, "base64url");

    // An empty plaintext is a legitimate value — a cleared optional secret —
    // and encrypts to the tag alone, so the body may be exactly TAG_BYTES.
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
        throw new Error("Encrypted value is malformed");
    }

    const ciphertext = body.subarray(0, body.length - TAG_BYTES);
    const tag = body.subarray(body.length - TAG_BYTES);

    for (const key of attempts) {
        try {
            const decipher = createDecipheriv(ALGORITHM, key.material, iv, {
                authTagLength: TAG_BYTES,
            });

            decipher.setAAD(Buffer.from(`${SCHEME}:${context}`, "utf8"));
            decipher.setAuthTag(tag);

            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]).toString("utf8");

            return { plaintext, staleKey: key.id !== ring[0].id };
        } catch {
            // Wrong key or tampered value; try the next key before giving up.
        }
    }

    throw new Error(
        "Could not decrypt: no key on the keyring matches, or the value was altered.",
    );
}

export function decrypt(stored: string, context = ""): string {
    return decryptWithMeta(stored, context).plaintext;
}

function timingSafeEqualString(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");

    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * For values we only ever compare, never read back: API keys. Stored as
 * sha256, with the first characters kept in the clear so a key is
 * recognisable in a list without being usable.
 */
export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, hash: string): boolean {
    return timingSafeEqualString(hashToken(token), hash);
}
