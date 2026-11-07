/**
 * Where rendered documents live.
 *
 * A finalized invoice has to be handed back byte for byte years after it was
 * issued, so the bytes are written once and kept — not re-rendered from a
 * template that has since been restyled. Today they go to a directory on
 * disk; the deployment that outgrows one node swaps in an S3-compatible
 * implementation, and nothing above this interface changes.
 */
export type StoredObject = {
    key: string;
    /** Hex SHA-256 of the bytes, so a later swap is detectable. */
    sha256: string;
    bytes: number;
};

export interface DocumentStorage {
    /** Names the backend in logs and in the admin area. */
    readonly id: string;
    /**
     * Writes `body` under `key`, overwriting what is there. Callers that must
     * not overwrite check first — the invoice service only ever writes a key
     * whose row still has none.
     */
    put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
    get(key: string): Promise<Buffer | null>;
    exists(key: string): Promise<boolean>;
    /** Only drafts are ever removed; a finalized document's bytes stay. */
    delete(key: string): Promise<void>;
}

/**
 * Keys are relative paths. The character set is deliberately narrow: a key
 * reaches the filesystem in the local implementation, so anything that could
 * climb out of the root is refused here rather than guarded against twice.
 */
export function assertStorageKey(key: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.includes("..")) {
        throw new Error(`Invalid storage key: ${key}`);
    }

    return key;
}
