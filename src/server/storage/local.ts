import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    assertStorageKey,
    type DocumentStorage,
    type StoredObject,
} from "./types";

/**
 * Documents on the local filesystem, under one root directory.
 *
 * Good enough for a single node and for development, and the only backend
 * that needs no credentials. The root is configurable because a container
 * wants it on a mounted volume rather than inside the image, where a
 * redeploy would take every stored invoice with it.
 */
export function localStorage(root: string): DocumentStorage {
    const base = path.resolve(root);

    function resolve(key: string) {
        const full = path.resolve(base, assertStorageKey(key));

        // Belt and braces: the key pattern already forbids `..`, but a
        // symlinked root or a future change to the pattern should not be the
        // only thing between a key and the rest of the disk.
        if (full !== base && !full.startsWith(`${base}${path.sep}`)) {
            throw new Error(`Storage key escapes the root: ${key}`);
        }

        return full;
    }

    return {
        id: `local:${base}`,

        async put(key, body, _contentType): Promise<StoredObject> {
            const full = resolve(key);

            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, body);

            return {
                key,
                sha256: createHash("sha256").update(body).digest("hex"),
                bytes: body.byteLength,
            };
        },

        async get(key) {
            try {
                return await readFile(resolve(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                    return null;
                }

                throw error;
            }
        },

        async exists(key) {
            try {
                await stat(resolve(key));

                return true;
            } catch {
                return false;
            }
        },

        async delete(key) {
            await rm(resolve(key), { force: true });
        },
    };
}
