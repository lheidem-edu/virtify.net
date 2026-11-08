import "server-only";
import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { documentStorage } from "@/server/storage";
import type { InboundAttachment, MailChannel } from "./channels/types";
import { stripControlCharacters } from "./sanitize";

/**
 * Where a ticket's attachments live, and how they are taken away again.
 *
 * The same store the invoices use (`src/server/storage`) — local disk today,
 * S3 a module away — but under a prefix of their own, because what an
 * invoice PDF is kept for (§ 147 AO, ten years, byte for byte) has nothing
 * to do with what an attachment is kept for.
 *
 * Unlike a finalized invoice's bytes, these are **removable**: a customer
 * who sent the wrong file, a DSGVO erasure, a ticket deleted by mistake.
 * Every write below has its matching delete.
 */

type Db = Pick<typeof defaultDb, "insert" | "select" | "delete">;

export type StoredAttachment = {
    id: string;
    messageId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    storageKey: string;
    sha256: string;
    contentId: string | null;
    isInline: boolean;
};

/**
 * Keys must match `assertStorageKey` in `src/server/storage/types.ts`, which
 * is narrow on purpose: the key reaches the filesystem. The sender's
 * filename therefore never reaches it — it is stored in the column and the
 * key carries the attachment's own ULID plus a flattened extension.
 */
export function attachmentKey(
    ticketId: string,
    attachmentId: string,
    filename: string,
): string {
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1] ?? "bin";

    return `tickets/${ticketId}/${attachmentId}.${extension.toLowerCase()}`;
}

/** A name that is safe to put in a Content-Disposition and in a UI. */
export function safeFilename(value: string): string {
    const trimmed = stripControlCharacters(value).replace(/[\\/]/g, "_").trim();

    return trimmed === "" ? "anhang" : trimmed.slice(0, 180);
}

export type DownloadedAttachment = StoredAttachment & { skipped: false };
export type SkippedAttachment = {
    skipped: true;
    filename: string;
    sizeBytes: number;
    reason: "too-large" | "gone" | "unreadable";
};

/**
 * Fetches the attachments of one message and writes them to the store.
 *
 * Runs **before** the transaction that records them, because a storage
 * write is not transactional and holding a database transaction open across
 * a network fetch is how a renewal pass turns into a lock queue. The ids are
 * minted here and handed to the insert, so the rows and the bytes agree; a
 * transaction that then rolls back leaves bytes nothing points at, and
 * `removeOrphans` is the way back.
 */
export async function downloadAttachments(
    channel: MailChannel,
    mailbox: string,
    channelMessageId: string,
    ticketId: string,
    messageId: string,
    attachments: readonly InboundAttachment[],
    options: { maxBytes: number; createId: () => string },
): Promise<(DownloadedAttachment | SkippedAttachment)[]> {
    const results: (DownloadedAttachment | SkippedAttachment)[] = [];
    const store = documentStorage();

    for (const attachment of attachments) {
        if (attachment.sizeBytes > options.maxBytes) {
            results.push({
                skipped: true,
                filename: safeFilename(attachment.filename),
                sizeBytes: attachment.sizeBytes,
                reason: "too-large",
            });

            continue;
        }

        let bytes: Buffer | null;

        /**
         * **One attachment may not take the message down with it.**
         *
         * Graph answers `$value` with a 405 for an item attachment and for
         * a OneDrive reference — neither of which is `gone`, so it used to
         * come out of here as a throw, the message never became a ticket,
         * and (since the delta cursor now waits for a message that failed)
         * the whole mailbox would stop behind it. The message is what the
         * customer wrote; the attachment is skipped, named and shown.
         */
        try {
            bytes = await channel.downloadAttachment(
                mailbox,
                channelMessageId,
                attachment.id,
            );
        } catch (error) {
            console.error(
                "[tickets] could not fetch the attachment",
                attachment.filename,
                "of",
                channelMessageId,
                error,
            );

            results.push({
                skipped: true,
                filename: safeFilename(attachment.filename),
                sizeBytes: attachment.sizeBytes,
                reason: "unreadable",
            });

            continue;
        }

        if (!bytes) {
            results.push({
                skipped: true,
                filename: safeFilename(attachment.filename),
                sizeBytes: attachment.sizeBytes,
                reason: "gone",
            });

            continue;
        }

        // The size Graph reports includes the MIME encoding overhead, so it
        // is checked again against what actually arrived.
        if (bytes.byteLength > options.maxBytes) {
            results.push({
                skipped: true,
                filename: safeFilename(attachment.filename),
                sizeBytes: bytes.byteLength,
                reason: "too-large",
            });

            continue;
        }

        const id = options.createId();
        const filename = safeFilename(attachment.filename);
        const key = attachmentKey(ticketId, id, filename);
        const stored = await store.put(
            key,
            bytes,
            attachment.contentType || "application/octet-stream",
        );

        results.push({
            skipped: false,
            id,
            messageId,
            filename,
            contentType: attachment.contentType || "application/octet-stream",
            sizeBytes: stored.bytes,
            storageKey: stored.key,
            sha256: stored.sha256,
            contentId: attachment.contentId,
            isInline: attachment.isInline,
        });
    }

    return results;
}

/** The way back from a write that was never recorded. */
export async function removeOrphans(keys: readonly string[]): Promise<void> {
    const store = documentStorage();

    for (const key of keys) {
        try {
            await store.delete(key);
        } catch (error) {
            console.error(
                "[tickets] could not remove an orphaned attachment:",
                key,
                error,
            );
        }
    }
}

/** Removes an attachment: the row and the bytes, in that order. */
export async function deleteAttachment(
    db: Db,
    attachmentId: string,
): Promise<boolean> {
    const removed = await db
        .delete(schema.ticketAttachment)
        .where(eq(schema.ticketAttachment.id, attachmentId))
        .returning({ storageKey: schema.ticketAttachment.storageKey });

    if (removed.length === 0) {
        return false;
    }

    // Row first, bytes second: the opposite order leaves a row pointing at
    // nothing if the delete fails halfway, which is the worse of the two.
    await removeOrphans(removed.map((row) => row.storageKey));

    return true;
}

export async function readAttachment(
    db: Pick<typeof defaultDb, "select">,
    attachmentId: string,
): Promise<{
    row: typeof schema.ticketAttachment.$inferSelect;
    bytes: Buffer;
} | null> {
    const [row] = await db
        .select()
        .from(schema.ticketAttachment)
        .where(eq(schema.ticketAttachment.id, attachmentId))
        .limit(1);

    if (!row) {
        return null;
    }

    const bytes = await documentStorage().get(row.storageKey);

    return bytes ? { row, bytes } : null;
}
