import qrcode from "qrcode-generator";

/**
 * EPC QR code — the "GiroCode" a banking app scans to fill in a SEPA credit
 * transfer. Specified by the European Payments Council in EPC069-12.
 *
 * The payload is eleven lines of plain text. Every field has a length limit
 * and the whole thing may not exceed 331 bytes, because the specification
 * fixes the symbol at error correction level M and version 13 at most — so a
 * payload that is one character too long produces a code that scanners either
 * refuse or, worse, read as a different amount. The builder therefore
 * truncates the free-text fields itself rather than letting the encoder
 * decide.
 *
 * The QR encoder is `qrcode-generator`: a single file, no dependencies, MIT,
 * and the only thing it does is turn bytes into a module matrix. Writing one
 * by hand would mean implementing Reed-Solomon error correction and mask
 * selection with nothing to validate the result against, on a code that ends
 * up on a document asking for money. (CLAUDE.md rule 12 — this is the why.)
 */

export type GiroCodeInput = {
    /** Beneficiary name, at most 70 characters. */
    name: string;
    /** IBAN; spaces are stripped. */
    iban: string;
    /** BIC. Optional for an EEA transfer under version 002. */
    bic?: string | null;
    /** Amount in whole cents. 1 cent to 999 999 999,99 €. */
    amountCents: number;
    /** Unstructured remittance information, at most 140 characters. */
    remittance: string;
};

const SERVICE_TAG = "BCD";
/** 002 is the version that makes the BIC optional inside the EEA. */
const VERSION = "002";
/** 1 = UTF-8. */
const CHARACTER_SET = "1";
const IDENTIFICATION = "SCT";

const MAX_PAYLOAD_BYTES = 331;
const MAX_NAME = 70;
const MAX_REMITTANCE = 140;

/** 999 999 999,99 € — the largest amount the specification allows. */
const MAX_AMOUNT_CENTS = 99_999_999_999;

export class GiroCodeError extends Error {}

function clip(value: string, limit: number) {
    // Cut on characters first, then on bytes: a name of 70 characters can
    // still be more than 70 bytes once umlauts are encoded, and the byte
    // budget is what the specification actually counts.
    let text = value
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, limit);

    while (Buffer.byteLength(text, "utf8") > limit) {
        text = text.slice(0, -1);
    }

    return text;
}

/** Cents as the "EUR12.34" the specification wants. */
function amountField(cents: number) {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
        throw new GiroCodeError(
            `A GiroCode needs a positive amount, not ${cents}`,
        );
    }

    if (cents > MAX_AMOUNT_CENTS) {
        throw new GiroCodeError("Amount exceeds what an EPC QR code can carry");
    }

    return `EUR${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function giroCodePayload(input: GiroCodeInput): string {
    const iban = input.iban.replace(/\s/g, "").toUpperCase();

    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
        throw new GiroCodeError(`Not an IBAN: ${input.iban}`);
    }

    const bic = (input.bic ?? "").replace(/\s/g, "").toUpperCase();

    const payload = [
        SERVICE_TAG,
        VERSION,
        CHARACTER_SET,
        IDENTIFICATION,
        bic,
        clip(input.name, MAX_NAME),
        iban,
        amountField(input.amountCents),
        // Purpose code and structured creditor reference: both unused here,
        // so the invoice number travels as unstructured remittance below.
        "",
        "",
        clip(input.remittance, MAX_REMITTANCE),
    ].join("\n");

    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new GiroCodeError("EPC payload exceeds 331 bytes");
    }

    return payload;
}

/**
 * The code as an SVG path, in a coordinate system of one unit per module.
 * Rendered as a single path rather than a few hundred rectangles, because
 * @react-pdf/renderer lays out every element it is given and a 33×33 symbol
 * is over a thousand of them.
 */
export type GiroCodeSymbol = { modules: number; path: string };

/**
 * The payload as the bytes that go into the symbol. Exported so the encoding
 * can be asserted directly rather than inferred from a module count.
 */
export function utf8Bytes(value: string): number[] {
    return [...Buffer.from(value, "utf8")];
}

export function giroCodeSymbol(input: GiroCodeInput): GiroCodeSymbol {
    const payload = giroCodePayload(input);

    // The encoder's own string-to-bytes keeps only the low byte of each
    // character, which would mangle an umlaut in the beneficiary's name into
    // a different account holder. The payload declares UTF-8 on line 3, so
    // the bytes have to be UTF-8.
    //
    // Done here rather than through the library's `stringToBytesFuncs`
    // table: that table exists in the CommonJS build and not in the ESM one,
    // so reaching for it works under tsx and vitest and is `undefined` in a
    // Next bundle — which is a 500 on an invoice PDF, found exactly that way.
    qrcode.stringToBytes = utf8Bytes;

    // Type 0 picks the smallest version that fits. "M" is what EPC069-12
    // prescribes and is not ours to choose.
    const code = qrcode(0, "M");
    code.addData(payload, "Byte");
    code.make();

    const modules = code.getModuleCount();
    const parts: string[] = [];

    for (let row = 0; row < modules; row++) {
        let col = 0;

        while (col < modules) {
            if (!code.isDark(row, col)) {
                col++;
                continue;
            }

            // Runs of dark modules become one rectangle, which roughly halves
            // the path for a typical symbol.
            const start = col;

            while (col < modules && code.isDark(row, col)) {
                col++;
            }

            parts.push(`M${start} ${row}h${col - start}v1h-${col - start}z`);
        }
    }

    return { modules, path: parts.join("") };
}
