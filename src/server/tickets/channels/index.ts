import "server-only";
import {
    hasWhatItNeeds,
    loadMailChannelConfig,
    type MailChannelId,
} from "../settings";
import { graphChannel } from "./graph";
import type { MailChannel } from "./types";

/**
 * The channel registry.
 *
 * One entry today. It exists as a registry anyway because the *shape* is
 * what Phase 7 owes the phases after it — a web form, an IMAP mailbox or a
 * chat widget is a new implementation of `MailChannel` and nothing else.
 *
 * Returns null when the channel is not configured, which is the normal
 * state of this installation: there are no tenant credentials, so every job
 * that would have talked to Microsoft finds no channel and does nothing.
 */
export async function mailChannel(
    id: MailChannelId = "msgraph",
): Promise<MailChannel | null> {
    const config = await loadMailChannelConfig(id);

    if (!config.enabled || !hasWhatItNeeds(config.credentials)) {
        return null;
    }

    return graphChannel({
        auth: {
            tenantId: config.credentials.tenantId,
            clientId: config.credentials.clientId,
            clientSecret: config.credentials.clientSecret,
        },
        processedFolder: config.processedFolder,
    });
}

export type { MailChannel } from "./types";
export * from "./types";
