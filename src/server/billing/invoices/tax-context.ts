import "server-only";
import type { Settings } from "@/server/settings";
import { normaliseCountry } from "@/server/tax/countries";
import { resolveTaxStrategy } from "@/server/tax/mode";
import type {
    TaxContext,
    TaxDetermination,
    TaxStrategy,
} from "@/server/tax/types";

/**
 * Turning the rows a document is built from into the context a tax strategy
 * reads. One place, so the storefront, an offer and a finalized invoice all
 * ask the same question in the same words — the whole point of the strategy
 * interface is that it cannot be fed a different buyer by a different caller.
 */

export type TaxBuyerRow = {
    country: string | null;
    kind: "company" | "private";
    vatId: string | null;
    vatIdValidatedAt: Date | null;
};

export function taxContextFor(
    buyer: TaxBuyerRow,
    settings: Settings,
    at: Date,
): TaxContext {
    return {
        seller: {
            country: normaliseCountry(settings.operator.country) ?? "DE",
            vatId: settings.operator.vatId || null,
            taxNumber: settings.operator.taxNumber || null,
        },
        buyer: {
            country: normaliseCountry(buyer.country),
            kind: buyer.kind,
            vatId: buyer.vatId,
            vatIdValidatedAt: buyer.vatIdValidatedAt,
        },
        at,
        // Everything in the catalogue is an electronically supplied service.
        supply: "service",
    };
}

export type Determined = {
    strategy: TaxStrategy;
    context: TaxContext;
    determination: TaxDetermination;
    notes: string[];
};

/**
 * The tax decision for a document being finalized at `at`. The strategy comes
 * from `tax_mode_history` keyed by that instant, never by "now" — which is
 * what makes a re-render of an old invoice produce the old answer.
 */
export async function determineTax(
    executor: Parameters<typeof resolveTaxStrategy>[0],
    buyer: TaxBuyerRow,
    settings: Settings,
    at: Date,
): Promise<Determined> {
    const strategy = await resolveTaxStrategy(executor, at);
    const context = taxContextFor(buyer, settings, at);

    return {
        strategy,
        context,
        determination: strategy.determine(context),
        notes: strategy.invoiceNotes(context),
    };
}
