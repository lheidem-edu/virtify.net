import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import { formatDate, formatPrice } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listCoupons, listProducts } from "@/server/catalog/repository";
import { CouponRowActions, NewCoupon } from "./coupon-forms";

export const dynamic = "force-dynamic";

const DURATION_LABEL: Record<string, string> = {
    once: "einmalig",
    repeating: "mehrere Zeiträume",
    forever: "dauerhaft",
};

/** `<input type="date">` wants `YYYY-MM-DD`; the row holds a Date. */
function forInput(value: Date | null): string {
    return value ? value.toISOString().slice(0, 10) : "";
}

export default async function Page() {
    await requirePermission("catalog.read");

    const coupons = await listCoupons(db);
    const products = await listProducts(db, { limit: 100 });

    const catalogue = products.data.map((row) => ({
        id: row.id,
        name: row.name,
    }));

    return (
        <>
            <PageHeader
                title="Gutscheine"
                intro="Prozent oder fester Betrag, einmalig, für eine Anzahl Zeiträume oder dauerhaft. Die Preisfunktion prüft jeden Code gegen Produkt, Zeitraum, Gültigkeit und Kontingent, bevor sie ihn abzieht."
                action={
                    <Link
                        href="/admin/catalog"
                        className="rounded-md border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Zurück zum Katalog
                    </Link>
                }
            />

            <section className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium tracking-tight">
                        Codes
                    </h2>
                    <NewCoupon products={catalogue} />
                </div>

                {coupons.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch kein Gutschein angelegt.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {coupons.map((coupon) => (
                            <li key={coupon.id} className="p-4">
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <div>
                                        <p className="font-mono text-sm">
                                            {coupon.code}
                                            <span className="ml-3 font-sans">
                                                <StatusBadge
                                                    label={
                                                        coupon.active
                                                            ? "Aktiv"
                                                            : "Aus"
                                                    }
                                                    tone={
                                                        coupon.active
                                                            ? "positive"
                                                            : "muted"
                                                    }
                                                />
                                            </span>
                                        </p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {coupon.kind === "percent"
                                                ? `${(
                                                      (coupon.percentBasisPoints ??
                                                          0) / 100
                                                  ).toLocaleString("de-DE", {
                                                      maximumFractionDigits: 2,
                                                  })} %`
                                                : formatPrice(
                                                      coupon.amountCents ?? 0,
                                                  )}
                                            {" · "}
                                            {DURATION_LABEL[coupon.duration] ??
                                                coupon.duration}
                                            {coupon.duration === "repeating"
                                                ? ` (${coupon.durationPeriods ?? 1})`
                                                : ""}
                                            {coupon.appliesToSetupFee
                                                ? " · auch auf die Einrichtung"
                                                : ""}
                                            {coupon.validUntil
                                                ? ` · bis ${formatDate(coupon.validUntil)}`
                                                : ""}
                                            {coupon.maxRedemptions
                                                ? ` · ${coupon.redemptions}/${coupon.maxRedemptions} eingelöst`
                                                : ` · ${coupon.redemptions} eingelöst`}
                                        </p>
                                    </div>
                                    <CouponRowActions
                                        coupon={{
                                            id: coupon.id,
                                            code: coupon.code,
                                            description:
                                                coupon.description ?? "",
                                            kind: coupon.kind,
                                            percent:
                                                coupon.percentBasisPoints ===
                                                null
                                                    ? ""
                                                    : String(
                                                          coupon.percentBasisPoints /
                                                              100,
                                                      ).replace(".", ","),
                                            amount:
                                                coupon.amountCents === null
                                                    ? ""
                                                    : (coupon.amountCents / 100)
                                                          .toFixed(2)
                                                          .replace(".", ","),
                                            currency: coupon.currency ?? "EUR",
                                            duration: coupon.duration,
                                            durationPeriods: String(
                                                coupon.durationPeriods ?? "",
                                            ),
                                            appliesToSetupFee:
                                                coupon.appliesToSetupFee,
                                            productIds: coupon.productIds,
                                            cycles: coupon.cycles,
                                            validFrom: forInput(
                                                coupon.validFrom,
                                            ),
                                            validUntil: forInput(
                                                coupon.validUntil,
                                            ),
                                            maxRedemptions: String(
                                                coupon.maxRedemptions ?? "",
                                            ),
                                            active: coupon.active,
                                        }}
                                        products={catalogue}
                                    />
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
}
