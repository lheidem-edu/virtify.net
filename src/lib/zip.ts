import { crc32 } from "node:zlib";

/**
 * A ZIP archive, written by hand, without compression.
 *
 * ## Why not a dependency
 *
 * Rule 12 asks for a reason either way, and this is the opposite call from
 * the one taken for the QR code. A QR encoder means Reed–Solomon and mask
 * selection, and getting it subtly wrong produces a code that scans
 * *somewhere else* — unverifiable without a second implementation, on an
 * artefact that asks for money. A store-only ZIP is a length-prefixed
 * container with a checksum the platform already computes (`zlib.crc32`,
 * Node ≥ 20.15): about a hundred lines, every field in the spec, and
 * verifiable three ways — by reading the central directory back, by
 * `unzip -t`, and by the fact that a wrong offset makes every reader refuse
 * the file rather than quietly hand back the wrong bytes.
 *
 * ## Stored, not deflated
 *
 * The archive holds a JSON document and PDFs. PDFs are already compressed, so
 * deflating them buys single-digit percent for CPU spent while a request is
 * held open, and `zlib.deflateRaw` would add a second thing that can be
 * subtly wrong. Method 0 it is, and every reader on every platform
 * understands it.
 *
 * ## No Zip64
 *
 * The format tops out at 4 GiB per entry and 65 535 entries. A DSGVO export
 * is one JSON file and one PDF per document; `assertZipLimits` refuses
 * anything beyond that rather than writing a header that silently truncates,
 * because a 4 GiB field that overflows produces an archive that *opens* and
 * is wrong.
 */

export type ZipEntry = {
    /** Forward slashes, no leading slash, no `..`. */
    name: string;
    content: Buffer;
    /** Defaults to now. Stored in the DOS format, which has a 2-second step. */
    modified?: Date;
};

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

/** Method 0: stored. See the header. */
const METHOD_STORED = 0;

/** Written into "version needed to extract": 2.0, which is what stored wants. */
const VERSION = 20;

/**
 * Bit 11 of the general purpose flags: the name is UTF-8.
 *
 * Load-bearing for this archive. Without it a reader is entitled to decode
 * the name as CP437, and `Rechnungskorrektur-2026-0003.pdf` is fine but
 * `Rechnungen/Angebot-Mühlenweg.pdf` is not — and the German product
 * language guarantees umlauts in a filename eventually.
 */
const FLAG_UTF8 = 0x0800;

const MAX_ENTRY_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export class ZipLimitError extends Error {}

function assertZipLimits(entries: readonly ZipEntry[]) {
    if (entries.length > MAX_ENTRIES) {
        throw new ZipLimitError(
            `A ZIP without Zip64 holds at most ${MAX_ENTRIES} entries; got ${entries.length}.`,
        );
    }

    let total = 0;

    for (const entry of entries) {
        if (entry.content.length > MAX_ENTRY_BYTES) {
            throw new ZipLimitError(
                `${entry.name} is larger than 4 GiB, which needs Zip64.`,
            );
        }

        total += entry.content.length;

        if (total > MAX_ENTRY_BYTES) {
            throw new ZipLimitError(
                "The archive is larger than 4 GiB, which needs Zip64.",
            );
        }
    }
}

/**
 * A name a reader will not refuse and an extractor cannot be walked out of
 * with.
 *
 * The same reasoning as `assertStorageKey`: an archive is extracted
 * somewhere, and a member called `../../etc/thing` is a path traversal in
 * whatever unpacks it. Backslashes are normalised because a Windows-style
 * separator in a ZIP member is itself ambiguous.
 */
export function zipName(name: string): string {
    const cleaned = name.replace(/\\/g, "/").replace(/^\/+/, "");

    if (
        cleaned.length === 0 ||
        cleaned.length > 1000 ||
        cleaned.split("/").some((part) => part === "." || part === "..")
    ) {
        throw new Error(`Invalid ZIP entry name: ${name}`);
    }

    return cleaned;
}

/** MS-DOS date and time, which is what the format stores. */
function dosStamp(date: Date): { time: number; date: number } {
    const year = date.getUTCFullYear();

    // 1980 is the epoch of the format. Anything before it is written as the
    // epoch rather than wrapping into a date in the far future.
    if (year < 1980) {
        return { time: 0, date: (1 << 5) | 1 };
    }

    return {
        // Seconds have a two-second resolution in this field; that is the
        // format, not a rounding choice.
        time:
            (date.getUTCHours() << 11) |
            (date.getUTCMinutes() << 5) |
            (date.getUTCSeconds() >> 1),
        date:
            ((year - 1980) << 9) |
            ((date.getUTCMonth() + 1) << 5) |
            date.getUTCDate(),
    };
}

/**
 * Builds the archive in memory.
 *
 * In memory because the whole thing is a few megabytes — one JSON document
 * and a customer's documents — and because the response is handed back as one
 * buffer anyway. A deployment whose customers have thousands of invoices
 * would stream this; `assertZipLimits` is where that becomes loud rather than
 * slow.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
    assertZipLimits(entries);

    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(zipName(entry.name), "utf8");
        const stamp = dosStamp(entry.modified ?? new Date());
        // `crc32` returns an unsigned 32-bit number; writeUInt32LE wants
        // exactly that, so no >>> 0 dance is needed.
        const checksum = crc32(entry.content);
        const size = entry.content.length;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIGNATURE_LOCAL, 0);
        local.writeUInt16LE(VERSION, 4);
        local.writeUInt16LE(FLAG_UTF8, 6);
        local.writeUInt16LE(METHOD_STORED, 8);
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        locals.push(local, name, entry.content);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(SIGNATURE_CENTRAL, 0);
        // "version made by": 2.0, and 0 for the MS-DOS/FAT attribute space,
        // which is what a reader expects when no external attributes are set.
        central.writeUInt16LE(VERSION, 4);
        central.writeUInt16LE(VERSION, 6);
        central.writeUInt16LE(FLAG_UTF8, 8);
        central.writeUInt16LE(METHOD_STORED, 10);
        central.writeUInt16LE(stamp.time, 12);
        central.writeUInt16LE(stamp.date, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(size, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        // Where this member's *local* header starts. A wrong value here is
        // the one mistake that produces an archive which opens and is wrong,
        // which is why the test reads the directory back rather than trusting
        // the byte count.
        central.writeUInt32LE(offset, 42);

        centrals.push(central, name);

        offset += local.length + name.length + size;
    }

    const directory = Buffer.concat(centrals);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIGNATURE_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, directory, end]);
}

export type ReadZipEntry = {
    name: string;
    content: Buffer;
    crcOk: boolean;
};

/**
 * Reads an archive back through its central directory.
 *
 * This exists for the tests rather than for the application: it is the second
 * implementation that makes the first one checkable, and it deliberately
 * follows the *directory* — offsets, names, sizes, checksums — instead of
 * walking the local headers in order, because following the directory is what
 * a real reader does and therefore what a wrong offset breaks.
 */
export function readZip(buffer: Buffer): ReadZipEntry[] {
    // The end record is at the very end when there is no comment, which is
    // what `buildZip` writes; scanning backwards anyway keeps this honest
    // against an archive that has one.
    let end = -1;

    for (let i = buffer.length - 22; i >= 0; i -= 1) {
        if (buffer.readUInt32LE(i) === SIGNATURE_END) {
            end = i;
            break;
        }
    }

    if (end < 0) {
        throw new Error(
            "Not a ZIP archive: no end-of-central-directory record",
        );
    }

    const count = buffer.readUInt16LE(end + 10);
    let cursor = buffer.readUInt32LE(end + 16);
    const out: ReadZipEntry[] = [];

    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) {
            throw new Error(`Corrupt central directory at entry ${i}`);
        }

        const crcExpected = buffer.readUInt32LE(cursor + 16);
        const size = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer
            .subarray(cursor + 46, cursor + 46 + nameLength)
            .toString("utf8");

        if (buffer.readUInt32LE(localOffset) !== SIGNATURE_LOCAL) {
            throw new Error(`Corrupt local header for ${name}`);
        }

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataAt = localOffset + 30 + localNameLength + localExtraLength;
        const content = buffer.subarray(dataAt, dataAt + size);

        out.push({ name, content, crcOk: crc32(content) === crcExpected });

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return out;
}
