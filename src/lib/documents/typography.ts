import fs from "node:fs";
import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Shared typography for everything we render as PDF. Inter is the website's
 * typeface; embedding it keeps documents in the same voice as the site and
 * avoids PDF's built-in Helvetica, which is what makes an invoice look like it
 * was typed in 1998.
 */

const FAMILY = "Inter";
const FALLBACK = "Helvetica";

const FACES = [
    { file: "Inter-Regular.ttf", fontWeight: 400 as const },
    { file: "Inter-Medium.ttf", fontWeight: 500 as const },
    { file: "Inter-SemiBold.ttf", fontWeight: 600 as const },
];

/**
 * The font files ship with the source tree, so they are resolved from the
 * working directory. If they are ever missing we fall back to Helvetica rather
 * than failing the render — a plain invoice still beats no invoice.
 */
function registerFonts(): string {
    const directory = path.join(
        process.cwd(),
        "src",
        "lib",
        "documents",
        "fonts",
    );

    try {
        const fonts = FACES.map((face) => {
            const src = path.join(directory, face.file);
            fs.accessSync(src, fs.constants.R_OK);
            return { src, fontWeight: face.fontWeight };
        });

        Font.register({ family: FAMILY, fonts });
        return FAMILY;
    } catch (error) {
        console.error(
            "[pdf] Inter unavailable, falling back to Helvetica",
            error,
        );
        return FALLBACK;
    }
}

/**
 * No hyphenation. The bundled pattern set is English, and German compounds
 * come out broken in the wrong places ("Anspruchs-voraussetzung"); German
 * business letters set ragged right without hyphens anyway.
 */
Font.registerHyphenationCallback((word) => [word]);

export const documentFont = registerFonts();

/** DIN measurements are in millimetres; PDF units are points. */
export const mm = (value: number) => value * 2.8346;

export const INK = "#111113";
export const MUTED = "#5b5b63";
export const FAINT = "#8f8f98";
export const RULE = "#d5d5dc";
export const HAIRLINE = "#e8e8ed";
