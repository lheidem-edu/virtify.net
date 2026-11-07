import "server-only";
import type { PaymentProvider } from "@/db/schema";
import { bankTransferGateway } from "./banktransfer";
import { paypalGateway } from "./paypal";
import { stripeGateway } from "./stripe";
import type { GatewayId, PaymentGateway } from "./types";

/**
 * The register. Everything that wants to take money asks here and gets the
 * interface, never a provider's module — which is what keeps `stripe` out of
 * a server action and `paypal` out of a page.
 *
 * `credit` is not in it on purpose. Spending a balance is not a gateway
 * collecting money from outside; it is a ledger entry and a payment row, and
 * it lives in `apply.ts` where the balance is. Giving it a `PaymentGateway`
 * would mean an interface of five methods that all throw.
 */

const GATEWAYS: Record<GatewayId, PaymentGateway> = {
    stripe: stripeGateway,
    paypal: paypalGateway,
    banktransfer: bankTransferGateway,
};

export function gateway(id: GatewayId): PaymentGateway {
    return GATEWAYS[id];
}

/** Null for `credit`, which has no gateway — see above. */
export function gatewayFor(provider: PaymentProvider): PaymentGateway | null {
    return provider === "credit" ? null : GATEWAYS[provider];
}

export function isGatewayId(value: string): value is GatewayId {
    return value in GATEWAYS;
}

/** The ones the operator has switched on, in the order they are offered. */
export async function enabledGateways(): Promise<PaymentGateway[]> {
    const all = [stripeGateway, paypalGateway, bankTransferGateway];
    const states = await Promise.all(all.map((one) => one.isEnabled()));

    return all.filter((_, index) => states[index]);
}

export type { GatewayId, PaymentGateway } from "./types";
