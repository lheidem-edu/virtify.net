import { describe, expect, it } from "vitest";
import {
    createId,
    idPrefixOf,
    isId,
    isUlid,
    ulid,
    ulidFactory,
    ulidTime,
    zId,
    zUlid,
} from "@/lib/ulid";

describe("ulid", () => {
    it("is 26 Crockford base32 characters", () => {
        const value = ulid();

        expect(value).toHaveLength(26);
        expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(isUlid(value)).toBe(true);
    });

    it("is strictly increasing within the same millisecond", () => {
        const at = ulidFactory();
        const seed = Date.UTC(2026, 0, 1);
        const ids = Array.from({ length: 1000 }, () => at(seed));

        for (let i = 1; i < ids.length; i += 1) {
            expect(ids[i] > ids[i - 1]).toBe(true);
        }

        // Same millisecond, so the time prefix must be identical throughout.
        expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1);
    });

    it("sorts in creation order across milliseconds", () => {
        const at = ulidFactory();
        const earlier = at(Date.UTC(2024, 5, 1));
        const later = at(Date.UTC(2026, 5, 1));

        expect(later > earlier).toBe(true);
    });

    it("round-trips the timestamp it encodes", () => {
        const when = Date.UTC(2026, 10, 6, 12, 34, 56, 789);

        expect(ulidTime(ulidFactory()(when)).getTime()).toBe(when);
    });

    it("keeps a seed in the past from rewriting a generator's clock", () => {
        // The guard that makes the shared ulid() refuse a seedTime at all.
        const at = ulidFactory();
        const now = Date.UTC(2026, 10, 6);

        at(now);
        const backwards = at(Date.UTC(2020, 0, 1));

        expect(ulidTime(backwards).getTime()).toBe(now);
    });

    it("rejects the letters Crockford leaves out", () => {
        expect(isUlid(`${"0".repeat(25)}I`)).toBe(false);
        expect(isUlid(`${"0".repeat(25)}L`)).toBe(false);
        expect(isUlid(`${"0".repeat(25)}O`)).toBe(false);
        expect(isUlid(`${"0".repeat(25)}U`)).toBe(false);
        expect(isUlid("0".repeat(25))).toBe(false);
        expect(isUlid(null)).toBe(false);
    });
});

describe("prefixed ids", () => {
    it("reads back its prefix", () => {
        const id = createId("invoice");

        expect(idPrefixOf(id)).toBe("invoice");
        expect(isId(id, "invoice")).toBe(true);
        expect(isId(id, "offer")).toBe(false);
        expect(isUlid(id)).toBe(false);
    });

    it("sorts by creation time within one table, prefix and all", () => {
        const first = createId("invoice");
        const second = createId("invoice");

        expect(second > first).toBe(true);
    });

    it("rejects a prefix with a broken ULID", () => {
        expect(isId("invoice_nope")).toBe(false);
        expect(isId("invoice_")).toBe(false);
        expect(isId("nounderscore")).toBe(false);
        expect(isId(42)).toBe(false);
    });
});

describe("zod schemas", () => {
    it("accepts and rejects the right shapes", () => {
        const bare = ulid();

        expect(zUlid.parse(bare)).toBe(bare);
        expect(zUlid.safeParse(`invoice_${bare}`).success).toBe(false);

        const id = createId("invoice");

        expect(zId("invoice").parse(id)).toBe(id);
        expect(zId("offer").safeParse(id).success).toBe(false);
    });

    it("carries OpenAPI metadata whose examples validate", () => {
        const bare = zUlid.meta();
        expect(bare?.description).toBeTruthy();
        expect(zUlid.safeParse(bare?.example).success).toBe(true);

        const prefixed = zId("invoice");
        expect(prefixed.safeParse(prefixed.meta()?.example).success).toBe(true);
    });
});
