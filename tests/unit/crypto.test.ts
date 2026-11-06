import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    decrypt,
    decryptWithMeta,
    encrypt,
    generateKey,
    hashToken,
    isEncrypted,
    parseKey,
    resetKeyring,
    setKeyring,
    tokenMatches,
} from "@/lib/crypto";

const KEY_A = "dGVzdC1rZXktYS1leGFjdGx5LTMyLWJ5dGVzLWxvbmc=";
const KEY_B = "dGVzdC1rZXktYi1leGFjdGx5LTMyLWJ5dGVzLWxvbmc=";

beforeEach(() => setKeyring([KEY_A]));
afterEach(() => resetKeyring());

describe("keys", () => {
    it("accepts base64 and hex of the right length", () => {
        expect(parseKey(KEY_A).material).toHaveLength(32);
        expect(parseKey("a".repeat(64)).material).toHaveLength(32);
        expect(parseKey(generateKey()).material).toHaveLength(32);
    });

    it("refuses a key that is not 32 bytes", () => {
        expect(() => parseKey("too-short")).toThrow(/32 bytes/);
        expect(() => parseKey("")).toThrow(/32 bytes/);
    });

    it("gives different keys different fingerprints", () => {
        expect(parseKey(KEY_A).id).not.toBe(parseKey(KEY_B).id);
        expect(parseKey(KEY_A).id).toBe(parseKey(KEY_A).id);
    });

    it("needs a key at all", () => {
        expect(() => setKeyring([])).toThrow(/at least one key/);
    });
});

describe("encrypt / decrypt", () => {
    it("round-trips a secret", () => {
        const secret = "sk_live_51UCz6ALMgRystASQ";
        const stored = encrypt(secret);

        expect(stored).not.toContain(secret);
        expect(isEncrypted(stored)).toBe(true);
        expect(decrypt(stored)).toBe(secret);
    });

    it("round-trips German text and emoji intact", () => {
        const secret = "Schlüssel für Grüße 🔐";

        expect(decrypt(encrypt(secret))).toBe(secret);
    });

    it("round-trips an empty string", () => {
        expect(decrypt(encrypt(""))).toBe("");
    });

    it("never produces the same ciphertext twice", () => {
        const first = encrypt("same");
        const second = encrypt("same");

        expect(first).not.toBe(second);
        expect(decrypt(first)).toBe(decrypt(second));
    });

    it("refuses a value that was altered", () => {
        const stored = encrypt("secret");
        const [scheme, keyId, iv, body] = stored.split(".");
        const flipped = `${body.slice(0, -2)}${body.slice(-2) === "AA" ? "AB" : "AA"}`;

        expect(() => decrypt([scheme, keyId, iv, flipped].join("."))).toThrow(
            /Could not decrypt/,
        );
    });

    it("refuses a value encrypted under a key the ring does not have", () => {
        const stored = encrypt("secret");

        setKeyring([KEY_B]);

        expect(() => decrypt(stored)).toThrow(/Could not decrypt/);
    });

    it("rejects something that is not a stored value", () => {
        expect(() => decrypt("plain text")).toThrow(/unknown scheme/);
        expect(() => decrypt("v2.a.b.c")).toThrow(/unknown scheme/);
        expect(isEncrypted("plain text")).toBe(false);
    });
});

describe("context binding", () => {
    it("will not open a value under a different context", () => {
        const stored = encrypt("hunter2", "mailbox.client_secret");

        expect(decrypt(stored, "mailbox.client_secret")).toBe("hunter2");
        expect(() => decrypt(stored, "server.api_token")).toThrow(
            /Could not decrypt/,
        );
        expect(() => decrypt(stored)).toThrow(/Could not decrypt/);
    });
});

describe("rotation", () => {
    it("reads a value written under a retired key and flags it", () => {
        const stored = encrypt("old secret");

        // New key first, the one that wrote the value retired behind it.
        setKeyring([KEY_B, KEY_A]);

        const opened = decryptWithMeta(stored);

        expect(opened.plaintext).toBe("old secret");
        expect(opened.staleKey).toBe(true);

        // Re-encrypting puts it on the current key.
        expect(decryptWithMeta(encrypt(opened.plaintext)).staleKey).toBe(false);
    });

    it("still finds the key when the fingerprint is unknown", () => {
        const stored = encrypt("secret");
        const [scheme, , iv, body] = stored.split(".");
        const anonymous = [scheme, "ZZZZZZZZ", iv, body].join(".");

        expect(decrypt(anonymous)).toBe("secret");
    });
});

describe("token hashing", () => {
    it("compares a token against its hash", () => {
        const token = "vfy_live_0123456789abcdef";
        const hash = hashToken(token);

        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(tokenMatches(token, hash)).toBe(true);
        expect(tokenMatches(`${token}x`, hash)).toBe(false);
        expect(tokenMatches("", hash)).toBe(false);
    });
});
