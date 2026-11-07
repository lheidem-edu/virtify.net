import { describe, expect, it } from "vitest";
import { hasWhatItNeeds, mergeCredentials } from "@/server/payments/settings";

/**
 * When a gateway counts as configured, and what a save does to the secrets
 * it was not given.
 *
 * Both of these decide whether money that was taken can be booked, and both
 * were wrong in the same direction: they said yes on less than the webhook
 * route needs. A gateway that is offered at the checkout but cannot verify a
 * delivery charges the customer and never settles the invoice — dunning then
 * chases somebody who has already paid.
 */

describe("whether a gateway has what it needs", () => {
    it("refuses Stripe without a webhook secret", () => {
        // `/api/webhooks/stripe` answers 503 without it, so every delivery is
        // lost: the Checkout session still charges the card.
        expect(
            hasWhatItNeeds("stripe", {
                secretKey: "sk_test_x",
                webhookSecret: "",
            }),
        ).toBe(false);

        expect(
            hasWhatItNeeds("stripe", {
                secretKey: "sk_test_x",
                webhookSecret: "whsec_x",
            }),
        ).toBe(true);
    });

    it("refuses Stripe without a secret key", () => {
        expect(
            hasWhatItNeeds("stripe", {
                secretKey: "",
                webhookSecret: "whsec_x",
            }),
        ).toBe(false);
    });

    it("refuses PayPal without a webhook id", () => {
        // Without it `CHECKOUT.ORDER.APPROVED` never arrives, and an order
        // the customer approved is never captured — PayPal voids it later
        // and the sale is simply gone.
        expect(
            hasWhatItNeeds("paypal", {
                clientId: "id",
                clientSecret: "secret",
                webhookId: "",
            }),
        ).toBe(false);

        expect(
            hasWhatItNeeds("paypal", {
                clientId: "id",
                clientSecret: "secret",
                webhookId: "WH-1",
            }),
        ).toBe(true);
    });

    it("needs nothing for a bank transfer", () => {
        // The IBAN is in the settings and is printed on every invoice.
        expect(hasWhatItNeeds("banktransfer", {})).toBe(true);
    });
});

describe("merging the secrets a save was given", () => {
    const stored = { secretKey: "sk_live_old", webhookSecret: "whsec_old" };

    it("keeps a secret the form left blank", () => {
        // Rotating the key used to write `{ new key, "" }` and take the
        // webhook down with it.
        expect(
            mergeCredentials(
                ["secretKey", "webhookSecret"],
                { secretKey: "sk_live_new", webhookSecret: "" },
                stored,
            ),
        ).toEqual({ secretKey: "sk_live_new", webhookSecret: "whsec_old" });
    });

    it("keeps the other secret when only the webhook one is retyped", () => {
        expect(
            mergeCredentials(
                ["secretKey", "webhookSecret"],
                { secretKey: "", webhookSecret: "whsec_new" },
                stored,
            ),
        ).toEqual({ secretKey: "sk_live_old", webhookSecret: "whsec_new" });
    });

    it("says nothing changed when every field was left blank", () => {
        // Which is what lets the operator flip the enabled switch without
        // re-typing a secret they cannot read back.
        expect(
            mergeCredentials(
                ["secretKey", "webhookSecret"],
                { secretKey: "", webhookSecret: "" },
                stored,
            ),
        ).toBeUndefined();
    });

    it("says nothing changed when the same value is retyped", () => {
        expect(
            mergeCredentials(
                ["secretKey", "webhookSecret"],
                { secretKey: "sk_live_old", webhookSecret: "" },
                stored,
            ),
        ).toBeUndefined();
    });

    it("fills a field that was never stored", () => {
        expect(
            mergeCredentials(
                ["clientId", "clientSecret", "webhookId"],
                { clientId: "id", clientSecret: "secret", webhookId: "WH-1" },
                {},
            ),
        ).toEqual({
            clientId: "id",
            clientSecret: "secret",
            webhookId: "WH-1",
        });
    });

    it("trims what was pasted", () => {
        // A trailing newline out of a password manager is the usual way a
        // key "does not work".
        expect(
            mergeCredentials(
                ["secretKey", "webhookSecret"],
                { secretKey: "  sk_live_new\n", webhookSecret: "" },
                stored,
            ),
        ).toEqual({ secretKey: "sk_live_new", webhookSecret: "whsec_old" });
    });
});
