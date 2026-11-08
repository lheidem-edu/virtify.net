import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@/lib/ulid";
import { creditBalanceCents } from "@/server/payments/apply";
import {
    applyChange,
    cancelPendingChange,
    previewChange,
} from "@/server/subscriptions/changes";
import {
    cancelSubscription,
    pauseSubscription,
    resumeCancellation,
    resumeSubscription,
    transitionSubscription,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    ACTOR,
    anchored,
    eventsOf,
    invoiceOf,
    itemsOf,
    makeCustomer,
    makeGroup,
    makeProduct,
    order,
    servicesOf,
    subscriptionOf,
    warmPool,
} from "../helpers/fixtures";

/**
 * The Abo itself: its state machine, pausing, cancelling and changing plan —
 * against a real Postgres, because every claim here is about what rows a
 * transaction leaves behind.
 *
 * The plan-change cases state concrete cents. They are the ones worth
 * reading twice: a preview is what the customer agrees to and the change is
 * what they are charged, and those two numbers come from one function on
 * purpose.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the subscription proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

/** The 1st of the month, so every period is a clean calendar month. */
const SETTINGS = anchored(1);
const START = new Date("2026-11-01T09:00:00.000+01:00");

describe.skipIf(!available)("subscriptions", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let groupId: string;
    let vpsM: string;
    let vpsL: string;
    let support: string;
    let seq = 20_000;

    function nextCustomer() {
        seq += 1;
        return makeCustomer(db, seq);
    }

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;
        groupId = await makeGroup(db);

        // 19,99 €/Monat
        vpsM = await makeProduct(db, {
            groupId,
            slug: "vps-m",
            name: "VPS M",
            cycle: "monthly",
            priceCents: 1999,
        });

        // 39,99 €/Monat — the upgrade target.
        vpsL = await makeProduct(db, {
            groupId,
            slug: "vps-l",
            name: "VPS L",
            cycle: "monthly",
            priceCents: 3999,
        });

        // A pure subscription product: nothing is provisioned for it.
        support = await makeProduct(db, {
            groupId,
            slug: "support",
            name: "Supportvertrag",
            type: "subscription",
            cycle: "monthly",
            priceCents: 2500,
        });
    }, 60_000);

    afterAll(async () => {
        await drop?.();
    });

    async function oneVps(quantity = 1, productId = vpsM) {
        const customerId = await nextCustomer();
        const placed = await order(db, {
            customerId,
            items: [{ productId, cycle: "monthly", quantity }],
            now: START,
            settings: SETTINGS,
        });

        const subscriptionId = placed.subscriptionIds[0];
        const [item] = await itemsOf(db, subscriptionId);

        return { customerId, placed, subscriptionId, item };
    }

    describe("the state machine, against the database", () => {
        it("refuses a move the table does not allow, and writes nothing", async () => {
            const { subscriptionId } = await oneVps();

            await transitionSubscription(db, {
                subscriptionId,
                to: "ended",
                summary: "Test",
                actor: ACTOR,
                at: START,
            });

            await expect(
                transitionSubscription(db, {
                    subscriptionId,
                    to: "active",
                    summary: "Zurück von den Toten",
                    actor: ACTOR,
                    at: START,
                }),
            ).rejects.toThrow(SubscriptionStateError);

            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "ended",
            );
        });

        it("is a no-op when it is already there, and leaves no timeline entry", async () => {
            const { subscriptionId } = await oneVps();
            const before = await eventsOf(db, subscriptionId);

            const result = await transitionSubscription(db, {
                subscriptionId,
                to: "active",
                summary: "Nochmal aktiv",
                actor: ACTOR,
                at: START,
            });

            expect(result.changed).toBe(false);
            expect(await eventsOf(db, subscriptionId)).toHaveLength(
                before.length,
            );
        });

        it("terminates the services when it ends", async () => {
            const { subscriptionId, item } = await oneVps(2);

            expect(await servicesOf(db, item.id)).toHaveLength(2);

            await transitionSubscription(db, {
                subscriptionId,
                to: "ended",
                summary: "Beendet",
                actor: ACTOR,
                at: START,
            });

            const services = await servicesOf(db, item.id);

            expect(services).toHaveLength(2);
            expect(services.every((row) => row.status === "terminated")).toBe(
                true,
            );
            expect(services.every((row) => row.terminatedAt !== null)).toBe(
                true,
            );
        });

        it("leaves a past_due service running — the grace is the point of dunning", async () => {
            const { subscriptionId, item } = await oneVps();

            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: START })
                .where(eq(schema.service.subscriptionItemId, item.id));

            await transitionSubscription(db, {
                subscriptionId,
                to: "past_due",
                summary: "Überfällig",
                actor: ACTOR,
                at: START,
            });

            expect((await servicesOf(db, item.id))[0].status).toBe("active");
        });

        it("never wakes a service that was only ever pending", async () => {
            const { subscriptionId, item } = await oneVps();

            await transitionSubscription(db, {
                subscriptionId,
                to: "past_due",
                summary: "Überfällig",
                actor: ACTOR,
                at: START,
            });
            await transitionSubscription(db, {
                subscriptionId,
                to: "active",
                summary: "Bezahlt",
                actor: ACTOR,
                at: START,
            });

            // Nobody has set it up: it is not "active" just because the
            // billing record is.
            expect((await servicesOf(db, item.id))[0].status).toBe("pending");
        });
    });

    describe("pausing and resuming", () => {
        it("suspends the services and stops billing", async () => {
            const { subscriptionId, item } = await oneVps();

            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: START })
                .where(eq(schema.service.subscriptionItemId, item.id));

            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-10T00:00:00.000+01:00"),
            });

            const paused = await subscriptionOf(db, subscriptionId);

            expect(paused.status).toBe("paused");
            expect(paused.nextBillingAt).toBeNull();
            expect((await servicesOf(db, item.id))[0].status).toBe("suspended");
        });

        it("gives back exactly the days it stood still", async () => {
            const { subscriptionId } = await oneVps();
            const before = await subscriptionOf(db, subscriptionId);

            // 2026-11-01 → 2026-12-01 is the first period.
            expect(before.currentPeriodEnd?.toISOString()).toBe(
                new Date("2026-12-01T00:00:00.000+01:00").toISOString(),
            );

            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-10T00:00:00.000+01:00"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-20T00:00:00.000+01:00"),
            });

            const after = await subscriptionOf(db, subscriptionId);

            expect(after.status).toBe("active");
            expect(after.pausedAt).toBeNull();
            // Ten days paused → ten days later.
            expect(after.currentPeriodEnd?.toISOString()).toBe(
                new Date("2026-12-11T00:00:00.000+01:00").toISOString(),
            );
            expect(after.nextBillingAt?.toISOString()).toBe(
                after.currentPeriodEnd?.toISOString(),
            );
        });

        it("wakes the services it suspended, and only those", async () => {
            const { subscriptionId, item } = await oneVps(2);
            const services = await servicesOf(db, item.id);

            // One running, one never set up.
            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: START })
                .where(eq(schema.service.id, services[0].id));

            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-10T00:00:00.000+01:00"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-12T00:00:00.000+01:00"),
            });

            const after = await servicesOf(db, item.id);
            const byId = new Map(after.map((row) => [row.id, row.status]));

            expect(byId.get(services[0].id)).toBe("active");
            expect(byId.get(services[1].id)).toBe("pending");
        });

        it("refuses to resume something that is not paused", async () => {
            const { subscriptionId } = await oneVps();

            await expect(
                resumeSubscription(db, { subscriptionId, actor: ACTOR }),
            ).rejects.toThrow(/nicht pausiert/);
        });
    });

    describe("cancelling", () => {
        it("at the end of the period keeps the services running", async () => {
            const { subscriptionId, item } = await oneVps();

            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: START })
                .where(eq(schema.service.subscriptionItemId, item.id));

            const result = await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: new Date("2026-11-05T00:00:00.000+01:00"),
            });

            const row = await subscriptionOf(db, subscriptionId);

            expect(result.status).toBe("cancelled");
            expect(row.status).toBe("cancelled");
            expect(row.cancelAtPeriodEnd).toBe(true);
            expect((await servicesOf(db, item.id))[0].status).toBe("active");
        });

        it("now ends it and terminates the services", async () => {
            const { subscriptionId, item } = await oneVps();

            await cancelSubscription(db, {
                subscriptionId,
                when: "now",
                actor: ACTOR,
                at: new Date("2026-11-05T00:00:00.000+01:00"),
            });

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("ended");
            expect(row.endedAt).not.toBeNull();
            expect(row.nextBillingAt).toBeNull();
            expect((await servicesOf(db, item.id))[0].status).toBe(
                "terminated",
            );
        });

        it("can be taken back while the period is still running", async () => {
            const { subscriptionId } = await oneVps();

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: new Date("2026-11-05T00:00:00.000+01:00"),
            });
            await resumeCancellation(db, {
                subscriptionId,
                actor: ACTOR,
                at: new Date("2026-11-06T00:00:00.000+01:00"),
            });

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("active");
            expect(row.cancelAtPeriodEnd).toBe(false);
            expect(row.cancelledAt).toBeNull();
        });

        it("refuses to cancel something already over", async () => {
            const { subscriptionId } = await oneVps();

            await cancelSubscription(db, {
                subscriptionId,
                when: "now",
                actor: ACTOR,
                at: START,
            });

            await expect(
                cancelSubscription(db, {
                    subscriptionId,
                    when: "now",
                    actor: ACTOR,
                }),
            ).rejects.toThrow(/bereits beendet/);
        });
    });

    describe("changing the plan, mid-cycle, in cents", () => {
        /** The 16th of a 30-day month: 15 days used, 15 to come. */
        const MIDWAY = new Date("2026-11-16T09:00:00.000+01:00");

        it("previews an upgrade to the cent — 19,99 → 39,99 is 10,00 € today", async () => {
            const { subscriptionId, item } = await oneVps();

            const preview = await previewChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "immediately",
                },
                { now: MIDWAY },
            );

            expect(preview.proration.periodDays).toBe(30);
            expect(preview.proration.remainingDays).toBe(15);
            // 1999 × 15/30 = 1000 back, 3999 × 15/30 = 2000 forward.
            expect(preview.proration.unusedCreditCents).toBe(1000);
            expect(preview.proration.newChargeCents).toBe(2000);
            expect(preview.invoiceTodayCents).toBe(1000);
            expect(preview.creditTodayCents).toBe(0);
            expect(preview.nextPeriodCents).toBe(3999);
            expect(preview.currentPeriodCents).toBe(1999);
        });

        it("charges exactly what the preview said, and no second arithmetic", async () => {
            const { subscriptionId, item, customerId } = await oneVps();

            const preview = await previewChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "immediately",
                },
                { now: MIDWAY },
            );

            const result = await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            expect(result.appliedNow).toBe(true);
            expect(result.invoiceId).not.toBeNull();

            const invoice = await invoiceOf(db, result.invoiceId as string);

            // The number on the screen is the number on the document.
            expect(invoice.grossCents).toBe(preview.invoiceTodayCents);
            expect(invoice.grossCents).toBe(1000);
            expect(invoice.status).toBe("unpaid");
            expect(invoice.number).toMatch(/^RE-/);
            expect(invoice.customerId).toBe(customerId);

            // And the Abo now says what was bought.
            const [after] = await itemsOf(db, subscriptionId);

            expect(after.productId).toBe(vpsL);
            expect(after.unitPriceCents).toBe(3999);
            expect(after.recurringGrossCents).toBe(3999);
        });

        it("credits the mirror figure on a downgrade, and raises no invoice", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsL, cycle: "monthly" }],
                now: START,
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];
            const [item] = await itemsOf(db, subscriptionId);

            expect(await creditBalanceCents(db, customerId)).toBe(0);

            const result = await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsM,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            // 3999 × 15/30 = 2000 back, 1999 × 15/30 = 1000 forward → −1000.
            expect(result.invoiceId).toBeNull();
            expect(result.creditedCents).toBe(1000);
            expect(result.preview.proration.differenceCents).toBe(-1000);
            expect(await creditBalanceCents(db, customerId)).toBe(1000);
        });

        it("moves no money for a change at the end of the period", async () => {
            const { subscriptionId, item, customerId } = await oneVps();

            const result = await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "period_end",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            expect(result.appliedNow).toBe(false);
            expect(result.invoiceId).toBeNull();
            expect(result.creditedCents).toBe(0);
            expect(await creditBalanceCents(db, customerId)).toBe(0);

            // The Abo keeps what it has until the period is over.
            const [unchanged] = await itemsOf(db, subscriptionId);

            expect(unchanged.productId).toBe(vpsM);

            const [pending] = await db
                .select()
                .from(schema.subscriptionChange)
                .where(
                    eq(
                        schema.subscriptionChange.subscriptionId,
                        subscriptionId,
                    ),
                );

            expect(pending.status).toBe("pending");
            expect(pending.applyAt.toISOString()).toBe(
                new Date("2026-12-01T00:00:00.000+01:00").toISOString(),
            );
        });

        it("allows only one pending change per position", async () => {
            const { subscriptionId, item } = await oneVps();

            await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "period_end",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            await expect(
                applyChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        productId: support,
                        effective: "period_end",
                    },
                    ACTOR,
                    { now: MIDWAY, settings: SETTINGS },
                ),
            ).rejects.toThrow();
        });

        it("withdraws a pending change and lets another be made", async () => {
            const { subscriptionId, item } = await oneVps();

            const first = await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "period_end",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            await cancelPendingChange(db, {
                changeId: first.changeId,
                actor: ACTOR,
                at: MIDWAY,
            });

            await expect(
                applyChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        productId: support,
                        effective: "period_end",
                    },
                    ACTOR,
                    { now: MIDWAY, settings: SETTINGS },
                ),
            ).resolves.toBeTruthy();
        });

        it("creates a service for an extra unit and terminates a surplus one", async () => {
            const { subscriptionId, item } = await oneVps(1);

            await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    quantity: 3,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            const grown = await servicesOf(db, item.id);

            expect(
                grown.filter((row) => row.status !== "terminated"),
            ).toHaveLength(3);

            await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    quantity: 2,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            const shrunk = await servicesOf(db, item.id);

            expect(
                shrunk.filter((row) => row.status !== "terminated"),
            ).toHaveLength(2);
            // The oldest machine is the one the customer has been using.
            expect(shrunk[0].status).not.toBe("terminated");
        });

        it("invents no service for a product that provisions nothing", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: support, cycle: "monthly" }],
                now: START,
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];
            const [item] = await itemsOf(db, subscriptionId);

            expect(await servicesOf(db, item.id)).toHaveLength(0);

            await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    quantity: 4,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            expect(await servicesOf(db, item.id)).toHaveLength(0);
        });

        it("refuses to book a preview the position has moved out from under", async () => {
            // Two changes to the same item racing each other: the second
            // would credit the unused days of a plan the first had already
            // replaced. The preview is computed before the row lock, so the
            // position is checked against it once nothing can move.
            const { subscriptionId, item } = await oneVps();

            await warmPool(db, 4);

            const results = await Promise.allSettled([
                applyChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        productId: vpsL,
                        effective: "immediately",
                    },
                    ACTOR,
                    { now: MIDWAY, settings: SETTINGS },
                ),
                applyChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        quantity: 4,
                        effective: "immediately",
                    },
                    ACTOR,
                    { now: MIDWAY, settings: SETTINGS },
                ),
            ]);

            const booked = results.filter(
                (entry) => entry.status === "fulfilled",
            );
            const refused = results.filter(
                (entry) => entry.status === "rejected",
            );

            expect(booked).toHaveLength(1);
            expect(refused).toHaveLength(1);
            expect(
                String((refused[0] as PromiseRejectedResult).reason),
            ).toMatch(/inzwischen geändert/);
        });

        it("refuses a change that changes nothing", async () => {
            // It would occupy the item's single pending slot and put a
            // "Tarifwechsel" on the customer's timeline for a non-event.
            const { subscriptionId, item } = await oneVps();

            await expect(
                applyChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        productId: vpsM,
                        quantity: 1,
                        effective: "period_end",
                    },
                    ACTOR,
                    { now: MIDWAY, settings: SETTINGS },
                ),
            ).rejects.toThrow(/aktuelle Tarif/);
        });

        it("refuses a position that belongs to another Abo", async () => {
            const a = await oneVps();
            const b = await oneVps();

            await expect(
                previewChange(
                    db,
                    {
                        subscriptionId: a.subscriptionId,
                        itemId: b.item.id,
                        productId: vpsL,
                        effective: "immediately",
                    },
                    { now: MIDWAY },
                ),
            ).rejects.toThrow(/gehört nicht zu diesem Abo/);
        });

        it("refuses to change an Abo that is over", async () => {
            const { subscriptionId, item } = await oneVps();

            await cancelSubscription(db, {
                subscriptionId,
                when: "now",
                actor: ACTOR,
                at: START,
            });

            await expect(
                previewChange(
                    db,
                    {
                        subscriptionId,
                        itemId: item.id,
                        productId: vpsL,
                        effective: "immediately",
                    },
                    { now: MIDWAY },
                ),
            ).rejects.toThrow(/beendetes Abo/);
        });

        it("writes the change onto the Abo's own timeline", async () => {
            const { subscriptionId, item } = await oneVps();

            await applyChange(
                db,
                {
                    subscriptionId,
                    itemId: item.id,
                    productId: vpsL,
                    effective: "immediately",
                },
                ACTOR,
                { now: MIDWAY, settings: SETTINGS },
            );

            const events = await eventsOf(db, subscriptionId);
            const change = events.filter((row) => row.kind === "change");

            expect(change).toHaveLength(1);
            expect(change[0].summary).toContain("VPS L");
            // `format()` separates the amount from the symbol with a
            // non-breaking space, so the figure is matched on its own.
            expect(change[0].summary).toContain("10,00");
            expect(change[0].data).toMatchObject({ prorationCents: 1000 });
        });
    });

    describe("the link from an invoice to its Abos", () => {
        it("is written by the checkout, for the very first invoice", async () => {
            const { subscriptionId, placed } = await oneVps();

            const [link] = await db
                .select()
                .from(schema.subscriptionInvoice)
                .where(
                    and(
                        eq(
                            schema.subscriptionInvoice.subscriptionId,
                            subscriptionId,
                        ),
                        eq(schema.subscriptionInvoice.kind, "initial"),
                    ),
                );

            expect(link).toBeTruthy();
            expect(link.invoiceId).toBe(placed.invoiceId);
            expect(link.netCents).toBe(1999);
        });

        it("refuses a second invoice for the same period and kind", async () => {
            const { subscriptionId, placed } = await oneVps();

            await expect(
                db.insert(schema.subscriptionInvoice).values({
                    id: createId("subscriptioninvoice"),
                    subscriptionId,
                    invoiceId: placed.invoiceId as string,
                    kind: "initial",
                    periodStart: (await subscriptionOf(db, subscriptionId))
                        .currentPeriodStart,
                }),
            ).rejects.toThrow();
        });
    });
});
