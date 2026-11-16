import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZip, readZip, ZipLimitError, zipName } from "@/lib/zip";

/**
 * The archive the DSGVO export is handed back in.
 *
 * Written by hand rather than taken from a dependency (see the module
 * header), so these are the three checks that make that defensible:
 *
 *  1. the bytes come back out, through the **central directory** — which is
 *     what a real reader follows, and therefore what a wrong offset breaks;
 *  2. the CRC in the directory matches the bytes behind it;
 *  3. `unzip -t`, where the system has it, agrees with all of the above.
 *
 * Together they are the second implementation that makes the first one
 * checkable. A test that only asserted `buffer.length > 0` would pass against
 * an archive no reader on earth could open.
 */

const HELLO = Buffer.from("Guten Tag, Welt.\n", "utf8");
const JSON_DOC = Buffer.from(
    JSON.stringify({ customer: "Kunde 1", grossCents: 1999 }),
    "utf8",
);

describe("the ZIP writer", () => {
    it("round-trips through the central directory", () => {
        const archive = buildZip([
            { name: "daten.json", content: JSON_DOC },
            { name: "rechnungen/RE-2026-0001.pdf", content: HELLO },
        ]);

        const read = readZip(archive);

        expect(read.map((entry) => entry.name)).toEqual([
            "daten.json",
            "rechnungen/RE-2026-0001.pdf",
        ]);
        expect(read[0].content.equals(JSON_DOC)).toBe(true);
        expect(read[1].content.equals(HELLO)).toBe(true);
        expect(read.every((entry) => entry.crcOk)).toBe(true);
    });

    it("stores the right CRC for each member, not the first one's", () => {
        const archive = buildZip([
            { name: "a.txt", content: Buffer.from("a") },
            { name: "b.txt", content: Buffer.from("bbbb") },
        ]);

        const read = readZip(archive);

        // Named explicitly rather than only via `crcOk`: a writer that put
        // the *same* checksum on every entry would still satisfy a
        // self-consistent reader if the reader read it from the same place.
        expect(crc32(Buffer.from("a"))).not.toBe(crc32(Buffer.from("bbbb")));
        expect(read[0].crcOk).toBe(true);
        expect(read[1].crcOk).toBe(true);
    });

    it("keeps an empty member", () => {
        const archive = buildZip([
            { name: "leer.txt", content: Buffer.alloc(0) },
        ]);
        const read = readZip(archive);

        expect(read).toHaveLength(1);
        expect(read[0].content).toHaveLength(0);
        expect(read[0].crcOk).toBe(true);
    });

    it("marks the name as UTF-8 in both headers", () => {
        // The product language is German, so an umlaut in a filename is a
        // matter of time, and bit 11 of the general-purpose flags is what
        // makes a reader decode it as UTF-8 rather than CP437.
        //
        // The *flag* is asserted and not only the round-trip: this reader
        // decodes as UTF-8 whatever the flag says, and so does macOS's
        // `unzip` — so a writer that dropped the bit would pass both of them
        // and fail on somebody's Windows Explorer. (It did: that mutation
        // survived until this assertion existed.)
        const archive = buildZip([
            { name: "belege/Angebot-Mühlenweg.pdf", content: HELLO },
        ]);

        expect(readZip(archive)[0].name).toBe("belege/Angebot-Mühlenweg.pdf");

        // Local header: signature(4) version(2) → flags at offset 6.
        expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);

        // Central directory: its own copy of the flags, at offset 8 of the
        // record. A reader may consult either, so both have to carry it.
        const end = archive.length - 22;
        const directoryAt = archive.readUInt32LE(end + 16);

        expect(archive.readUInt16LE(directoryAt + 8) & 0x0800).toBe(0x0800);
    });

    it("writes an archive the system's unzip accepts", () => {
        const archive = buildZip([
            { name: "daten.json", content: JSON_DOC },
            { name: "rechnungen/RE-2026-0001.pdf", content: HELLO },
            { name: "belege/Angebot-Mühlenweg.pdf", content: HELLO },
        ]);

        const dir = mkdtempSync(join(tmpdir(), "virtify-zip-"));
        const file = join(dir, "export.zip");
        writeFileSync(file, archive);

        let output: string;

        try {
            output = execFileSync("unzip", ["-t", file], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            const code = (error as { code?: string }).code;

            if (code === "ENOENT") {
                // Loud rather than silent, the way the integration suite skips
                // when there is no database: a check that quietly stops
                // running is a check that stops protecting anything.
                console.warn(
                    "\n[tests] `unzip` is not installed — the third-party ZIP\n" +
                        "        check is being SKIPPED. The round-trip through\n" +
                        "        the central directory still ran.\n",
                );

                return;
            }

            throw error;
        }

        expect(output).toContain("No errors detected");
    });

    it("refuses a name that could climb out of the extraction directory", () => {
        expect(() => zipName("../../etc/passwd")).toThrow();
        expect(() => zipName("belege/../../etc/passwd")).toThrow();
        expect(() => zipName("")).toThrow();
        // A leading slash is normalised rather than refused: it is unambiguous
        // and every writer in the wild strips it.
        expect(zipName("/belege/a.pdf")).toBe("belege/a.pdf");
        expect(zipName("belege\\a.pdf")).toBe("belege/a.pdf");
    });

    it("refuses more members than the format can address", () => {
        const many = Array.from({ length: 65_536 }, (_, i) => ({
            name: `f${i}.txt`,
            content: Buffer.alloc(0),
        }));

        expect(() => buildZip(many)).toThrow(ZipLimitError);
    });
});
