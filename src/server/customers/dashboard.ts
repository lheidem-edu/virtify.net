import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";
import { add, subtract } from "@/lib/money";
import { creditBalanceCents } from "@/server/payments/apply";

/**
 * Everything the client overview shows, in one place.
 *
 * It takes a customer id and never looks one up: under `(client)` the only
 * caller is a page that got it from `getCurrentCustomer()`, which is the one
 * way client-area code learns which rows it may touch (rule 5). A loader that
 * resolved its own customer would be a second answer to that question.
 *
 * Everything that means "this invoice still wants money" asks
 * `OPEN_INVOICE_STATUSES` and never a literal — `partial` is an open invoice
 * (rule 3), and a dashboard that showed a part-paid invoice as settled would
 * be the one place in the product that disagreed with the dunning ladder.
 */

type Reader = Pick<typeof defaultDb, "select">;

export type AttentionItem =
    | {
          kind: "overdue";
          invoiceId: string;
          number: string;
          amountCents: number;
          dueAt: Date;
      }
    | { kind: "suspended"; serviceId: string; label: string }
    | {
          kind: "trial";
          subscriptionId: string;
          label: string;
          endsAt: Date;
      };

export type Dashboard = {
    subscriptions: { active: number; total: number };
    services: { active: number; total: number; suspended: number };
    invoices: { open: number; outstandingCents: number };
    tickets: { open: number };
    creditCents: number;
    currency: string;
    /** The things a customer should do something about, worst first. */
    attention: AttentionItem[];
    nextRenewal: { subscriptionId: string; label: string; at: Date } | null;
};

/** `trialing` and `active` both mean "this is running and will be billed". */
const LIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

export async function loadDashboard(
    db: Reader,
    customerId: string,
    options: { now?: Date; currency?: string } = {},
): Promise<Dashboard> {
    const now = options.now ?? new Date();

    const subscriptions = await db
        .select({
            id: schema.subscription.id,
            status: schema.subscription.status,
            nextBillingAt: schema.subscription.nextBillingAt,
            trialEndsAt: schema.subscription.trialEndsAt,
        })
        .from(schema.subscription)
        .where(eq(schema.subscription.customerId, customerId))
        .orderBy(asc(schema.subscription.id));

    const services = await db
        .select({
            id: schema.service.id,
            label: schema.service.label,
            status: schema.service.status,
        })
        .from(schema.service)
        .where(eq(schema.service.customerId, customerId))
        .orderBy(asc(schema.service.id));

    const invoices = await db
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
            dueAt: schema.invoice.dueAt,
        })
        .from(schema.invoice)
        .where(
            and(
                eq(schema.invoice.customerId, customerId),
                inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
            ),
        )
        .orderBy(asc(schema.invoice.dueAt));

    const tickets = await db
        .select({ id: schema.ticket.id })
        .from(schema.ticket)
        .where(
            and(
                eq(schema.ticket.customerId, customerId),
                ne(schema.ticket.status, "closed"),
            ),
        );

    const creditCents = await creditBalanceCents(db, customerId);

    /**
     * What is still owed, summed from the documents rather than from a
     * column: `gross − credited − paid`, which is the same arithmetic
     * `settlementFor` does, and never a stored total that could drift from
     * the movements that explain it.
     */
    const outstandingCents = add(
        ...invoices.map((row) =>
            subtract(
                Math.max(subtract(row.grossCents ?? 0, row.creditedCents), 0),
                row.paidCents,
            ),
        ),
    );

    const attention: AttentionItem[] = [];

    for (const row of invoices) {
        if (row.dueAt && row.dueAt.getTime() <= now.getTime() && row.number) {
            attention.push({
                kind: "overdue",
                invoiceId: row.id,
                number: row.number,
                amountCents: subtract(
                    Math.max(
                        subtract(row.grossCents ?? 0, row.creditedCents),
                        0,
                    ),
                    row.paidCents,
                ),
                dueAt: row.dueAt,
            });
        }
    }

    for (const row of services) {
        if (row.status === "suspended") {
            attention.push({
                kind: "suspended",
                serviceId: row.id,
                label: row.label,
            });
        }
    }

    const trialing = subscriptions.filter(
        (row) => row.status === "trialing" && row.trialEndsAt,
    );

    if (trialing.length > 0) {
        const labels = await subscriptionLabels(
            db,
            trialing.map((row) => row.id),
        );

        for (const row of trialing) {
            if (!row.trialEndsAt) {
                continue;
            }

            attention.push({
                kind: "trial",
                subscriptionId: row.id,
                label: labels.get(row.id) ?? "Ihr Abo",
                endsAt: row.trialEndsAt,
            });
        }
    }

    const upcoming = subscriptions
        .filter(
            (row) =>
                row.nextBillingAt !== null &&
                (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
                    row.status,
                ),
        )
        .sort(
            (a, b) =>
                (a.nextBillingAt?.getTime() ?? 0) -
                (b.nextBillingAt?.getTime() ?? 0),
        );

    const next = upcoming[0];
    const nextLabel = next
        ? (await subscriptionLabels(db, [next.id])).get(next.id)
        : null;

    return {
        subscriptions: {
            active: subscriptions.filter((row) =>
                (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
                    row.status,
                ),
            ).length,
            total: subscriptions.length,
        },
        services: {
            active: services.filter((row) => row.status === "active").length,
            total: services.filter((row) => row.status !== "terminated").length,
            suspended: services.filter((row) => row.status === "suspended")
                .length,
        },
        invoices: { open: invoices.length, outstandingCents },
        tickets: { open: tickets.length },
        creditCents,
        currency: options.currency ?? "EUR",
        attention,
        nextRenewal:
            next?.nextBillingAt != null
                ? {
                      subscriptionId: next.id,
                      label: nextLabel ?? "Ihr Abo",
                      at: next.nextBillingAt,
                  }
                : null,
    };
}

/** The first position's description, which is what the customer ordered. */
async function subscriptionLabels(
    db: Reader,
    ids: readonly string[],
): Promise<Map<string, string>> {
    if (ids.length === 0) {
        return new Map();
    }

    const rows = await db
        .select({
            subscriptionId: schema.subscriptionItem.subscriptionId,
            description: schema.subscriptionItem.description,
            position: schema.subscriptionItem.position,
        })
        .from(schema.subscriptionItem)
        .where(inArray(schema.subscriptionItem.subscriptionId, [...ids]))
        .orderBy(
            asc(schema.subscriptionItem.subscriptionId),
            asc(schema.subscriptionItem.position),
        );

    const out = new Map<string, string>();

    for (const row of rows) {
        if (!out.has(row.subscriptionId)) {
            out.set(row.subscriptionId, row.description);
        }
    }

    return out;
}
