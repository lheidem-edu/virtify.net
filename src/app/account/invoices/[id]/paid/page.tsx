import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import { loadInvoice } from "@/lib/documents/repository";
import { formatPrice } from "@/lib/format";
import { captureAndSettle, settleCheckoutReturn } from "@/lib/payments/collect";

type Query = Record<string, string | string[] | undefined>;

/** Providers append their own parameters, so a value can arrive repeated. */
function single(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The webhook is the authority on whether a payment settled; this only closes
 * the gap between the customer coming back and the page being able to say so.
 * Every failure is logged and swallowed — the invoice still settles on its
 * own, and reloading this page must never turn into an error the customer has
 * to interpret.
 */
async function settleOnReturn(invoiceId: string, query: Query) {
    const sessionId = single(query.session_id);

    try {
        if (sessionId) {
            // Verifies the session's own invoice metadata against the route
            // before it settles anything.
            await settleCheckoutReturn(sessionId, invoiceId);
            return;
        }

        if (single(query.provider) !== "paypal") {
            return;
        }

        // PayPal appends the approved order as `token`. It is taken from the
        // URL but trusted for nothing: only an order this invoice actually
        // started is captured, so a token pasted from somewhere else finds no
        // attempt and does nothing. Without it — an older PayPal flow, or a
        // stripped parameter — the invoice's newest open attempt is the best
        // guess left.
        const token = single(query.token);

        const [attempt] = await db
            .select({ providerRef: schema.payment.providerRef })
            .from(schema.payment)
            .where(
                and(
                    eq(schema.payment.invoiceId, invoiceId),
                    eq(schema.payment.provider, "paypal"),
                    eq(schema.payment.status, "pending"),
                    ...(token ? [eq(schema.payment.providerRef, token)] : []),
                ),
            )
            .orderBy(desc(schema.payment.createdAt))
            .limit(1);

        if (attempt) {
            await captureAndSettle(attempt.providerRef);
        }
    } catch (error) {
        console.error("[payment] settling on return failed:", error);
    }
}

export default async function Page({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
}) {
    const session = await requireSession();
    const { id } = await params;
    const query = await searchParams;

    const loaded = await loadInvoice(id, session.user.id, false);

    // Ownership lives in the query: someone else's invoice is simply not here.
    if (!loaded || loaded.invoice.status === "draft") {
        notFound();
    }

    let invoice = loaded.invoice;

    if (invoice.status !== "paid") {
        await settleOnReturn(invoice.id, query);
        invoice =
            (await loadInvoice(invoice.id, session.user.id, false))?.invoice ??
            invoice;
    }

    const paid = invoice.status === "paid";
    const number = invoice.number ?? invoice.id;

    return (
        <>
            <PageHeader
                title={paid ? "Zahlung eingegangen" : "Zahlung unterwegs"}
                intro={
                    paid
                        ? `Vielen Dank. Wir haben ${formatPrice(loaded.totals.grossCents)} für Rechnung ${number} erhalten.`
                        : `Deine Zahlung über ${formatPrice(loaded.totals.grossCents)} für Rechnung ${number} wird gerade verarbeitet.`
                }
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                    {paid
                        ? "Die Rechnung ist damit ausgeglichen; du musst nichts weiter tun. Beleg und XRechnung findest du weiterhin in deiner Rechnungsübersicht."
                        : "Das kann einen Moment dauern. Sobald die Zahlung bei uns eingegangen ist, wird die Rechnung von selbst als bezahlt geführt — du musst dafür nichts tun und diese Seite nicht offen lassen."}
                </p>
                <div className="mt-8">
                    <Button
                        nativeButton={false}
                        variant="outline"
                        size="lg"
                        render={<Link href="/account/invoices" />}
                    >
                        Zurück zu den Rechnungen
                    </Button>
                </div>
            </div>
        </>
    );
}
