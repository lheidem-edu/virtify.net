import "server-only";
import { and, asc, eq, lte } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type {
    BillingCycle,
    Coupon,
    Subscription,
    SubscriptionItem,
} from "@/db/schema";
import { add, format } from "@/lib/money";
import { createId } from "@/lib/ulid";
import type { Actor } from "@/server/audit";
import {
    createInvoiceDraftIn,
    finalizeInvoiceIn,
    resolveFinalizeOptions,
} from "@/server/billing/invoices/service";
import type { QuoteSelection } from "@/server/billing/pricing";
import {
    calculateProration,
    type Proration,
    prorationSpan,
} from "@/server/billing/proration";
import { quoteProductDetail } from "@/server/billing/quote";
import { renewalCoupon, renewalQuote } from "@/server/billing/renewal";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { CatalogError } from "@/server/catalog/repository";
import { ONE_OFF_UNIT } from "@/server/orders/lines";
import { adjustCreditIn } from "@/server/payments/apply";
import { loadSettings, type Settings } from "@/server/settings";
import { lockSubscription, recordEvent, SubscriptionError } from "./service";

/**
 * Plan changes: a different product, a different quantity, different add-ons.
 *
 * The one rule this file exists to keep: **the preview and the change are
 * the same function.** `previewChange()` computes everything, `applyChange()`
 * calls it and then books what it said. `GET …/preview-change` and
 * `POST …/change` therefore cannot disagree, which matters more here than
 * almost anywhere else — the preview is the number the customer agrees to,
 * and the change is the number they are charged. Phase 4 shipped a checkout
 * that showed 29,99 € and charged 25,99 € because two pieces of code did the
 * same arithmetic; here that would be the same defect with a signed
 * agreement attached to it.
 *
 * And the arithmetic itself lives in neither: every price comes out of
 * `calculateQuote()` (through `renewalQuote`, the same call the renewal run
 * makes), and the split over the remaining days comes out of
 * `calculateProration()`, which is pure and tested in cents.
 *
 * **Both directions, one figure.** `proration.differenceCents` is positive
 * when the customer owes and negative when we do. An upgrade books an
 * invoice for it; a downgrade books the same number as credit on the
 * account. There is no second rule for the way back.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ChangeEffective = "immediately" | "period_end";

export type ChangeRequest = {
    subscriptionId: string;
    /** Which position of the Abo changes. */
    itemId: string;
    /** Defaults to the product the item already names. */
    productId?: string | null;
    quantity?: number | null;
    /** Null leaves the add-ons as they are; `[]` removes all of them. */
    options?: { optionId: string; valueId: string; quantity: number }[] | null;
    effective: ChangeEffective;
};

export type ChangeTarget = {
    productId: string;
    description: string;
    quantity: number;
    /** Per unit, per whole period, at today's catalog price. */
    unitPriceCents: number;
    /** Base plus add-ons for one whole period, before any coupon. */
    recurringGrossCents: number;
    selections: QuoteSelection[];
};

export type ChangePreview = {
    subscriptionId: string;
    itemId: string;
    currency: string;
    cycle: BillingCycle;
    effective: ChangeEffective;
    /** When it takes effect. Now, or the first instant of the next period. */
    applyAt: Date;
    current: ChangeTarget;
    next: ChangeTarget;
    proration: Proration;
    /** What is invoiced today. Zero for a change at the end of the period. */
    invoiceTodayCents: number;
    /** What is credited to the account today. Zero likewise. */
    creditTodayCents: number;
    /** What one whole period of the **whole** Abo costs afterwards. */
    nextPeriodCents: number;
    /** And what it costs today, for the sentence beside it. */
    currentPeriodCents: number;
    /** German, for the line on the invoice and the preview. */
    label: string;
};

/** What the preview would have charged, as the line it becomes. */
function prorationLabel(input: {
    description: string;
    remainingDays: number;
    periodDays: number;
}): string {
    // No period to divide — the free days of a trial, or a one-off sale.
    // "anteilig für 0 von 0 Tagen" is not a sentence anybody can act on.
    if (input.periodDays <= 0) {
        return `Tarifwechsel: ${input.description} — ohne anteilige Abrechnung`;
    }

    return (
        `Tarifwechsel: ${input.description} — anteilig für ` +
        `${input.remainingDays} von ${input.periodDays} Tagen`
    );
}

async function loadItem(
    executor: Db | Tx,
    subscriptionId: string,
    itemId: string,
): Promise<SubscriptionItem> {
    const [item] = await executor
        .select()
        .from(schema.subscriptionItem)
        .where(
            and(
                eq(schema.subscriptionItem.id, itemId),
                eq(schema.subscriptionItem.subscriptionId, subscriptionId),
            ),
        );

    if (!item) {
        throw new SubscriptionError(
            "item",
            "Diese Position gehört nicht zu diesem Abo.",
        );
    }

    return item;
}

async function loadCoupon(
    executor: Db | Tx,
    couponId: string | null,
): Promise<Coupon | null> {
    if (!couponId) {
        return null;
    }

    const [row] = await executor
        .select()
        .from(schema.coupon)
        .where(eq(schema.coupon.id, couponId));

    return row ?? null;
}

/** One item priced as a renewal would price it: the same call, same coupon. */
function periodCents(input: {
    item: {
        id: string;
        productId: string;
        description: string;
        quantity: number;
        unitPriceCents: number;
        selections: QuoteSelection[];
    };
    subscription: Pick<Subscription, "cycle" | "currency">;
    coupon: ReturnType<typeof renewalCoupon>;
    now: Date;
}): number {
    return renewalQuote({
        item: input.item,
        cycle: input.subscription.cycle,
        currency: input.subscription.currency,
        coupon: input.coupon,
        now: input.now,
    }).totals.firstPeriodCents;
}

/**
 * What a change would cost, down to the cent, without changing anything.
 *
 * Everything `applyChange` books comes from here, and the endpoint that
 * shows the customer a price calls exactly this.
 */
export async function previewChange(
    executor: Db,
    request: ChangeRequest,
    options: { now?: Date } = {},
): Promise<ChangePreview> {
    const now = options.now ?? new Date();

    const [subscription] = await executor
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.id, request.subscriptionId));

    if (!subscription) {
        throw new SubscriptionError("not-found", "Dieses Abo gibt es nicht.");
    }

    if (subscription.status === "ended") {
        throw new SubscriptionError(
            "not-live",
            "Ein beendetes Abo lässt sich nicht mehr ändern.",
        );
    }

    const item = await loadItem(executor, subscription.id, request.itemId);
    const coupon = renewalCoupon({
        coupon: await loadCoupon(executor, subscription.couponId),
        periodsRemaining: subscription.discountPeriodsRemaining,
        now,
    });

    const currentSelections = item.selections as QuoteSelection[];
    const productId = request.productId ?? item.productId;
    const quantity = request.quantity ?? item.quantity;

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new SubscriptionError(
            "item",
            "Die Menge muss eine ganze Zahl ab 1 sein.",
        );
    }

    /**
     * The new configuration is priced from the **catalog**, at today's
     * prices — that is what agreeing to a different plan means. The old one
     * keeps its snapshot, because a running Abo is not repriced by a catalog
     * that has moved on.
     *
     * `loadSellableProduct` rather than a lookup by id: it is the same
     * function the storefront and `POST /api/v1/orders` use, so a slug works
     * here exactly as it works there, and "not for sale" means the same
     * thing in all three places — a retired tariff cannot be switched *to*
     * even by somebody who knows its id.
     */
    const detail = await loadSellableProduct(executor, productId);

    if (!detail) {
        throw new CatalogError("Dieses Produkt ist nicht bestellbar.");
    }

    const quoted = await quoteProductDetail(
        executor,
        detail,
        {
            cycle: subscription.cycle,
            currency: subscription.currency,
            quantity,
            options:
                request.options ??
                currentSelections.map((selection) => ({
                    optionId: selection.optionId,
                    valueId: selection.valueId,
                    quantity: selection.quantity,
                })),
            couponCode: null,
        },
        // No billing anchor: this is the price of a *whole* period. Cutting
        // it to the rest of the current one is `calculateProration`'s job,
        // and doing it twice would halve it twice.
        { now },
    );

    const base = quoted.quote.lines.find((line) => line.kind === "base");
    const next: ChangeTarget = {
        productId: detail.product.id,
        description: quoted.quote.productName,
        quantity,
        unitPriceCents:
            base?.periodUnitAmountCents ?? base?.unitAmountCents ?? 0,
        recurringGrossCents: quoted.quote.totals.recurringGrossCents,
        selections: quoted.selections,
    };

    const current: ChangeTarget = {
        productId: item.productId,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        recurringGrossCents: item.recurringGrossCents,
        selections: currentSelections,
    };

    const currentPeriodItemCents = periodCents({
        item: { ...current, id: item.id },
        subscription,
        coupon,
        now,
    });
    const nextPeriodItemCents = periodCents({
        item: { ...next, id: item.id },
        subscription,
        coupon,
        now,
    });

    /**
     * The days still ahead, over the days the whole-period prices above
     * actually buy — `prorationSpan`, not the raw length of the row's own
     * period. A trial is free and a short first period was charged at a
     * fraction of a month, and dividing a whole month's price by either of
     * them hands out money nobody paid.
     */
    const span = prorationSpan({
        at: now,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        cycle: subscription.cycle,
    });

    const proration =
        request.effective === "immediately"
            ? calculateProration({
                  currentPeriodGrossCents: currentPeriodItemCents,
                  nextPeriodGrossCents: nextPeriodItemCents,
                  ...span,
              })
            : calculateProration({
                  currentPeriodGrossCents: currentPeriodItemCents,
                  nextPeriodGrossCents: nextPeriodItemCents,
                  remainingDays: 0,
                  periodDays: span.periodDays,
              });

    // What the rest of the Abo costs per period, so the preview can say what
    // the next invoice will be rather than only what this line does.
    const siblings = await executor
        .select()
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, subscription.id))
        .orderBy(asc(schema.subscriptionItem.position));

    const othersCents = add(
        ...siblings
            .filter((row) => row.id !== item.id)
            .map((row) =>
                periodCents({
                    item: {
                        id: row.id,
                        productId: row.productId,
                        description: row.description,
                        quantity: row.quantity,
                        unitPriceCents: row.unitPriceCents,
                        selections: row.selections as QuoteSelection[],
                    },
                    subscription,
                    coupon,
                    now,
                }),
            ),
    );

    return {
        subscriptionId: subscription.id,
        itemId: item.id,
        currency: subscription.currency,
        cycle: subscription.cycle,
        effective: request.effective,
        applyAt:
            request.effective === "immediately"
                ? now
                : (subscription.currentPeriodEnd ?? now),
        current,
        next,
        proration,
        invoiceTodayCents: proration.owedByCustomerCents,
        creditTodayCents: proration.owedToCustomerCents,
        nextPeriodCents: add(othersCents, nextPeriodItemCents),
        currentPeriodCents: add(othersCents, currentPeriodItemCents),
        label: prorationLabel({
            description: next.description,
            remainingDays: proration.remainingDays,
            periodDays: proration.periodDays,
        }),
    };
}

export type ChangeResult = {
    preview: ChangePreview;
    changeId: string;
    /** The invoice an immediate upgrade raised, where it raised one. */
    invoiceId: string | null;
    invoiceNumber: string | null;
    creditedCents: number;
    appliedNow: boolean;
};

/**
 * Books what the preview said.
 *
 * Immediate: the item is rewritten, the difference is invoiced (upgrade) or
 * credited (downgrade), and the services follow the quantity. At the end of
 * the period: nothing moves today, a `pending` row records what was agreed,
 * and the renewal run applies it to the item when it builds the invoice for
 * the period it takes effect in.
 *
 * The whole thing is one transaction. A subscription item rewritten without
 * its invoice, or an invoice raised for a change that was not made, are both
 * worse than the change not happening.
 */
export async function applyChange(
    db: Db,
    request: ChangeRequest,
    actor: Actor,
    options: { now?: Date; settings?: Settings } = {},
): Promise<ChangeResult> {
    const now = options.now ?? new Date();
    const settings = options.settings ?? (await loadSettings());
    // Outside the transaction, so the number counter's lock is never held
    // across a settings read. Same reason as the checkout's.
    const finalizeOptions = await resolveFinalizeOptions({ now, settings });

    // Priced before the lock is taken: it reads the catalog and nothing it
    // reads is written below, and the row lock exists to serialise the
    // booking rather than the arithmetic.
    const preview = await previewChange(db, request, { now });

    return db.transaction(async (tx) => {
        const subscription = await lockSubscription(tx, request.subscriptionId);

        if (subscription.status === "ended") {
            throw new SubscriptionError(
                "not-live",
                "Ein beendetes Abo lässt sich nicht mehr ändern.",
            );
        }

        const item = await loadItem(tx, subscription.id, request.itemId);

        /**
         * The preview was computed before the lock was taken — it reads the
         * catalog, which the lock has nothing to do with. So the position is
         * checked against what the preview was computed *from* now that
         * nothing can move: two changes to the same item racing each other
         * would otherwise have the second one credit the unused days of a
         * plan the first one had already replaced.
         *
         * The same shape as the checkout's "der Warenkorb hat sich geändert"
         * — rolling back and asking for a fresh figure is the only honest
         * answer, because the one on the screen is about something else now.
         */
        if (
            item.productId !== preview.current.productId ||
            item.quantity !== preview.current.quantity ||
            item.unitPriceCents !== preview.current.unitPriceCents ||
            item.recurringGrossCents !== preview.current.recurringGrossCents
        ) {
            throw new SubscriptionError(
                "item",
                "Die Position hat sich inzwischen geändert. Bitte den Preis neu berechnen.",
            );
        }

        /**
         * A change that changes nothing is refused rather than recorded.
         *
         * Not pedantry: with `period_end` it would occupy the one pending
         * slot the item has, so a real change afterwards would be refused by
         * the unique index instead; and on the customer's own timeline it
         * reads "Tarifwechsel auf VPS M" while nothing happened. The price
         * is part of the comparison, so re-confirming an unchanged
         * configuration at a *new* catalog price is still a change.
         */
        if (isSameConfiguration(preview)) {
            throw new SubscriptionError(
                "item",
                "Das ist schon der aktuelle Tarif dieser Position.",
            );
        }

        const changeId = createId("subscriptionchange");
        const immediate = request.effective === "immediately";

        let invoiceId: string | null = null;
        let invoiceNumber: string | null = null;
        let creditedCents = 0;

        if (immediate && preview.invoiceTodayCents > 0) {
            const draft = await createInvoiceDraftIn(
                tx,
                {
                    customerId: subscription.customerId,
                    introText: `Zur Änderung Ihres Abos vom ${new Intl.DateTimeFormat(
                        "de-DE",
                        { dateStyle: "medium", timeZone: "Europe/Berlin" },
                    ).format(now)}.`,
                    items: [
                        {
                            description: preview.label,
                            detail: `statt ${preview.current.description}`,
                            quantity: 1,
                            unitCode: ONE_OFF_UNIT,
                            unitPriceCents: preview.invoiceTodayCents,
                            servicePeriodStart: now,
                            servicePeriodEnd:
                                subscription.currentPeriodEnd &&
                                new Date(
                                    subscription.currentPeriodEnd.getTime() - 1,
                                ),
                            subscriptionItemId: item.id,
                        },
                    ],
                },
                actor,
            );

            const finalized = await finalizeInvoiceIn(
                tx,
                draft.id,
                actor,
                finalizeOptions,
            );

            invoiceId = draft.id;
            invoiceNumber = finalized.number;

            await tx.insert(schema.subscriptionInvoice).values({
                id: createId("subscriptioninvoice"),
                subscriptionId: subscription.id,
                invoiceId,
                kind: "change",
                // The instant of the change, not the period's start: a
                // second change inside one period is a second document, and
                // the unique key has to let both exist.
                periodStart: now,
                periodEnd: subscription.currentPeriodEnd,
                netCents: finalized.totals.netCents,
            });
        }

        if (immediate && preview.creditTodayCents > 0) {
            /**
             * The mirror. The same `differenceCents` the upgrade invoiced,
             * read the other way round and booked as credit on the account —
             * which the next renewal then spends automatically.
             *
             * Not a Rechnungskorrektur: a correction credits *positions* of a
             * document (EN 16931, § 14 Abs. 4), and the unused days of a
             * plan are not a position of the invoice that sold it. Money the
             * customer is owed with no document to hang it on is exactly
             * what the balance is for.
             */
            await adjustCreditIn(tx, {
                customerId: subscription.customerId,
                amountCents: preview.creditTodayCents,
                reason: `Tarifwechsel — Gutschrift für ${preview.proration.remainingDays} von ${preview.proration.periodDays} Tagen`,
                actor,
            });

            creditedCents = preview.creditTodayCents;
        }

        await tx.insert(schema.subscriptionChange).values({
            id: changeId,
            subscriptionId: subscription.id,
            subscriptionItemId: item.id,
            status: immediate ? "applied" : "pending",
            effective: request.effective,
            direction:
                preview.next.productId !== preview.current.productId
                    ? preview.proration.direction === "downgrade"
                        ? "downgrade"
                        : "upgrade"
                    : preview.next.quantity !== preview.current.quantity
                      ? "quantity"
                      : preview.proration.direction,
            productId: preview.next.productId,
            description: preview.next.description,
            quantity: preview.next.quantity,
            selections: preview.next.selections,
            unitPriceCents: preview.next.unitPriceCents,
            recurringGrossCents: preview.next.recurringGrossCents,
            prorationCents: immediate ? preview.proration.differenceCents : 0,
            invoiceId,
            applyAt: preview.applyAt,
            appliedAt: immediate ? now : null,
        });

        if (immediate) {
            await writeItemFromChange(tx, {
                itemId: item.id,
                subscriptionId: subscription.id,
                customerId: subscription.customerId,
                target: preview.next,
                at: now,
                cause: changeId,
            });
        }

        await recordEvent(tx, {
            subscriptionId: subscription.id,
            kind: "change",
            summary: immediate
                ? `Tarifwechsel auf „${preview.next.description}“${
                      preview.invoiceTodayCents > 0
                          ? ` — ${format(preview.invoiceTodayCents)} anteilig berechnet`
                          : preview.creditTodayCents > 0
                            ? ` — ${format(preview.creditTodayCents)} gutgeschrieben`
                            : ""
                  }.`
                : `Tarifwechsel auf „${preview.next.description}“ zum Ende des Zeitraums vorgemerkt.`,
            data: {
                changeId,
                from: preview.current.description,
                to: preview.next.description,
                quantity: preview.next.quantity,
                prorationCents: immediate
                    ? preview.proration.differenceCents
                    : 0,
                invoiceNumber,
            },
            actor,
            at: now,
        });

        return {
            preview,
            changeId,
            invoiceId,
            invoiceNumber,
            creditedCents,
            appliedNow: immediate,
        };
    });
}

/**
 * Writes a target configuration onto a subscription item, and moves the
 * services that hang off it.
 *
 * Called both by an immediate change and by the renewal run when a change
 * agreed for the end of the period comes due — one function, so the two
 * paths cannot write the item differently.
 *
 * Quantity is the part that touches real things: two VPS becoming three is a
 * third machine, which is a `pending` service for Phase 8's module to set
 * up, and three becoming two terminates the newest. A *product* change
 * leaves the service rows in place with the new product and module recorded
 * on them — the actual "resize the machine" is `changePackage()` in Phase 8,
 * and the event written here is what will drive it.
 */
export async function writeItemFromChange(
    tx: Tx,
    input: {
        itemId: string;
        subscriptionId: string;
        customerId: string;
        target: ChangeTarget;
        at: Date;
        /**
         * Phase 8. The `subscription_change` row's id, which is the request
         * key of the module calls this sets off — one agreed change is one
         * package change and one teardown of whatever the quantity dropped.
         */
        cause?: string | null;
    },
) {
    const [item] = await tx
        .select()
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.id, input.itemId));

    if (!item) {
        throw new SubscriptionError("item", "Diese Position gibt es nicht.");
    }

    await tx
        .update(schema.subscriptionItem)
        .set({
            productId: input.target.productId,
            description: input.target.description,
            quantity: input.target.quantity,
            unitPriceCents: input.target.unitPriceCents,
            recurringGrossCents: input.target.recurringGrossCents,
            selections: input.target.selections,
            updatedAt: input.at,
        })
        .where(eq(schema.subscriptionItem.id, input.itemId));

    const existing = await tx
        .select()
        .from(schema.service)
        .where(eq(schema.service.subscriptionItemId, input.itemId))
        .orderBy(asc(schema.service.id));

    /**
     * Nothing was ever provisioned for this item — a pure `subscription`
     * product, which Phase 4 deliberately gives no service row. Then there
     * is nothing for the quantity to move, and inventing one here would
     * hand Phase 8's module a machine nobody ordered.
     */
    if (existing.length === 0) {
        return;
    }

    // A terminated service is history: it is not counted towards the
    // quantity and a quantity going back up does not resurrect it.
    const running = existing.filter((row) => row.status !== "terminated");

    const [product] = await tx
        .select()
        .from(schema.product)
        .where(eq(schema.product.id, input.target.productId));

    for (const row of running) {
        await tx
            .update(schema.service)
            .set({
                productId: input.target.productId,
                module: product?.module ?? row.module,
                label: input.target.description,
                updatedAt: input.at,
            })
            .where(eq(schema.service.id, row.id));
    }

    /**
     * Phase 8: the machine follows the tariff.
     *
     * Only when the **product** changed. A module reads its specification
     * out of `product.module_config` and nowhere else, so a quantity going
     * from two to three leaves each existing machine exactly as it was —
     * the third one is a new service row, and asking the cluster to resize
     * the other two to the size they already are is an API call that can
     * only fail.
     */
    if (input.cause && product && item.productId !== input.target.productId) {
        const { onPackageChanged } = await import(
            "@/server/provisioning/hooks"
        );

        await onPackageChanged(tx, {
            serviceIds: running.map((row) => row.id),
            cause: input.cause,
        });
    }

    const wanted = input.target.quantity;

    if (running.length < wanted) {
        for (let unit = running.length; unit < wanted; unit += 1) {
            await tx.insert(schema.service).values({
                id: createId("service"),
                customerId: input.customerId,
                subscriptionItemId: input.itemId,
                productId: input.target.productId,
                status: "pending",
                label:
                    wanted > 1
                        ? `${input.target.description} (${unit + 1}/${wanted})`
                        : input.target.description,
                module: product?.module ?? "none",
                provisioningMode: product?.provisioningMode ?? "manual",
            });
        }
    }

    if (running.length > wanted) {
        // Newest first: the oldest machine is the one the customer has been
        // using, and taking that one away to honour a quantity change would
        // be the panel picking the worst of the options.
        const retired: string[] = [];

        for (const row of running.slice(wanted).reverse()) {
            await tx
                .update(schema.service)
                .set({
                    status: "terminated",
                    terminatedAt: input.at,
                    updatedAt: input.at,
                })
                .where(eq(schema.service.id, row.id));

            retired.push(row.id);
        }

        /**
         * And the machines actually go away. Keyed on the change, so the
         * renewal run applying the same pending change twice — it cannot,
         * because the row is claimed `pending` — would still ask for one
         * teardown. The addresses and the reserved VMID come back when the
         * module reports the VM gone; see `runner.ts`.
         *
         * The new services a quantity *increase* creates are deliberately
         * **not** enqueued here. They are `pending`, and whether they may be
         * built without a person is the create sweep's question, which also
         * asks whether the proration invoice has been paid.
         */
        if (input.cause && retired.length > 0) {
            const { onServicesFollowed } = await import(
                "@/server/provisioning/hooks"
            );

            await onServicesFollowed(tx, {
                serviceIds: retired,
                follow: "terminated",
                cause: input.cause,
            });
        }
    }
}

/**
 * Puts into force every change that was agreed for a period, at the moment
 * that period actually begins.
 *
 * Deliberately **not** where the renewal invoice is raised. That happens
 * `renewalLeadDays` earlier, and the invoice may honestly bill the new
 * configuration — it bills the period the change belongs to. The item and
 * the services may not move with it: the customer has paid for what they
 * have until the last instant of the running period, and terminating a
 * machine early is the one thing in this file that cannot be taken back.
 *
 * So the renewal reads the promise and `advancePeriods()` keeps it. A
 * renewal that is taken back in between leaves the change `pending`, which
 * is what it still is, and the fresh invoice bills it again.
 *
 * The caller holds the subscription `FOR UPDATE` and only a row that is
 * still `pending` is claimed, so a second pass over the same day finds
 * nothing left to do.
 */
export async function applyDueChangesIn(
    tx: Tx,
    input: {
        subscriptionId: string;
        customerId: string;
        /** The first instant of the period that has just begun. */
        periodStart: Date;
        at: Date;
        actor: Actor;
    },
): Promise<number> {
    const due = await tx
        .select()
        .from(schema.subscriptionChange)
        .where(
            and(
                eq(
                    schema.subscriptionChange.subscriptionId,
                    input.subscriptionId,
                ),
                eq(schema.subscriptionChange.status, "pending"),
                lte(schema.subscriptionChange.applyAt, input.periodStart),
            ),
        )
        .orderBy(asc(schema.subscriptionChange.id))
        .for("update");

    for (const change of due) {
        await writeItemFromChange(tx, {
            itemId: change.subscriptionItemId,
            subscriptionId: input.subscriptionId,
            customerId: input.customerId,
            target: {
                productId: change.productId,
                description: change.description,
                quantity: change.quantity,
                unitPriceCents: change.unitPriceCents,
                recurringGrossCents: change.recurringGrossCents,
                selections: change.selections as QuoteSelection[],
            },
            at: input.at,
            cause: change.id,
        });

        await tx
            .update(schema.subscriptionChange)
            .set({
                status: "applied",
                appliedAt: input.at,
                updatedAt: input.at,
            })
            .where(eq(schema.subscriptionChange.id, change.id));

        await recordEvent(tx, {
            subscriptionId: input.subscriptionId,
            kind: "change",
            summary: `Vorgemerkter Tarifwechsel auf „${change.description}“ ist in Kraft.`,
            data: { changeId: change.id },
            actor: input.actor,
            at: input.at,
        });
    }

    return due.length;
}

/** Withdraws a change that was agreed for the end of the period. */
export async function cancelPendingChange(
    db: Db,
    input: { changeId: string; actor: Actor; at?: Date },
) {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(schema.subscriptionChange)
            .where(eq(schema.subscriptionChange.id, input.changeId))
            .for("update");

        if (row?.status !== "pending") {
            throw new SubscriptionError(
                "item",
                "Dieser Tarifwechsel steht nicht mehr aus.",
            );
        }

        await tx
            .update(schema.subscriptionChange)
            .set({ status: "cancelled", updatedAt: at })
            .where(eq(schema.subscriptionChange.id, row.id));

        await recordEvent(tx, {
            subscriptionId: row.subscriptionId,
            kind: "change",
            summary: `Vorgemerkter Tarifwechsel auf „${row.description}“ zurückgenommen.`,
            data: { changeId: row.id },
            actor: input.actor,
            at,
        });

        return row;
    });
}

/** The change waiting on one item, where there is one. */
export async function pendingChangeFor(
    executor: Db | Tx,
    subscriptionItemId: string,
) {
    const [row] = await executor
        .select()
        .from(schema.subscriptionChange)
        .where(
            and(
                eq(
                    schema.subscriptionChange.subscriptionItemId,
                    subscriptionItemId,
                ),
                eq(schema.subscriptionChange.status, "pending"),
            ),
        );

    return row ?? null;
}

/** Every change waiting on one Abo. */
export async function pendingChangesFor(
    executor: Db | Tx,
    subscriptionId: string,
) {
    return executor
        .select()
        .from(schema.subscriptionChange)
        .where(
            and(
                eq(schema.subscriptionChange.subscriptionId, subscriptionId),
                eq(schema.subscriptionChange.status, "pending"),
            ),
        )
        .orderBy(asc(schema.subscriptionChange.id));
}

/** Whether the preview would leave the position exactly as it is. */
function isSameConfiguration(preview: ChangePreview): boolean {
    const { current, next } = preview;

    const shape = (selections: QuoteSelection[]) =>
        selections
            .map(
                (selection) =>
                    `${selection.optionId}:${selection.valueId}:${selection.quantity}`,
            )
            .sort()
            .join("|");

    return (
        current.productId === next.productId &&
        current.quantity === next.quantity &&
        // A new catalog price for the same configuration *is* a change.
        current.recurringGrossCents === next.recurringGrossCents &&
        current.unitPriceCents === next.unitPriceCents &&
        shape(current.selections) === shape(next.selections)
    );
}

/** What a preview reads as, for the UI and the API. */
export function describePreview(preview: ChangePreview): string {
    if (preview.effective === "period_end") {
        return `Ab dem nächsten Zeitraum ${format(preview.nextPeriodCents)} statt ${format(preview.currentPeriodCents)}.`;
    }

    if (preview.invoiceTodayCents > 0) {
        return `Heute ${format(preview.invoiceTodayCents)} anteilig, danach ${format(preview.nextPeriodCents)} je Zeitraum.`;
    }

    if (preview.creditTodayCents > 0) {
        return `${format(preview.creditTodayCents)} werden Ihrem Guthaben gutgeschrieben, danach ${format(preview.nextPeriodCents)} je Zeitraum.`;
    }

    return `Keine Zahlung heute, danach ${format(preview.nextPeriodCents)} je Zeitraum.`;
}
