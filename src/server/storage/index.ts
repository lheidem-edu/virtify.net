import "server-only";
import { env } from "@/lib/env";
import { localStorage } from "./local";
import type { DocumentStorage } from "./types";

/**
 * The document store this installation uses.
 *
 * Resolved lazily and cached, for the same reason the payment configuration
 * is: `next build` imports every route to collect its data and must not be
 * made to care about where documents are kept.
 */
let cached: DocumentStorage | null = null;

export function documentStorage(): DocumentStorage {
    cached ??= localStorage(env.DOCUMENT_STORAGE_PATH);

    return cached;
}

/** Only for tests, which point the store at a temporary directory. */
export function setDocumentStorage(storage: DocumentStorage | null) {
    cached = storage;
}

export * from "./types";
export { localStorage };
