import { ulid } from "ulid";

/**
 * Every identifier is `<prefix>_<ULID>` — Stripe-style. The prefix makes an
 * id self-describing in logs and support requests, and ULIDs sort by creation
 * time, so an index on the primary key is also roughly chronological.
 */
export const ID_PREFIX = {
    user: "user",
    session: "session",
    account: "account",
    verification: "verification",
    twoFactor: "twofactor",
    contract: "contract",
    offer: "offer",
    offerItem: "offeritem",
    invoice: "invoice",
    invoiceItem: "invoiceitem",
    payment: "payment",
    paymentMethod: "paymentmethod",
    legalDocument: "legaldocument",
    legalSection: "legalsection",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function createId(prefix: IdPrefix) {
    return `${prefix}_${ulid()}`;
}
