"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCustomer } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";

export type DecisionState = {
    status: "idle" | "done" | "error";
    message?: string;
};

/**
 * Accepting an offer is the customer's declaration of acceptance under § 3 of
 * the terms, so it does two things atomically: it creates the contract from
 * the offered terms and records the decision. Both happen in one transaction
 * — an accepted offer without its contract would leave the customer bound to
 * something that does not exist.
 */
export async function decideOffer(
    _previous: DecisionState,
    data: FormData,
): Promise<DecisionState> {
    const session = await requireCustomer();

    const offerId = String(data.get("offerId") ?? "");
    const decision = String(data.get("decision") ?? "");

    if (decision !== "accept" && decision !== "decline") {
        return { status: "error", message: "Unbekannte Aktion." };
    }

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(
                    and(
                        eq(schema.offer.id, offerId),
                        eq(schema.offer.userId, session.user.id),
                    ),
                )
                .for("update");

            if (!row) {
                throw new Error("not-found");
            }

            // Only a sent offer can be decided, and only once — re-submitting
            // the form must not create a second contract.
            if (row.status !== "sent") {
                throw new Error("not-open");
            }

            if (row.validUntil && row.validUntil < new Date()) {
                await tx
                    .update(schema.offer)
                    .set({ status: "expired", updatedAt: new Date() })
                    .where(eq(schema.offer.id, offerId));
                throw new Error("expired");
            }

            if (decision === "decline") {
                await tx
                    .update(schema.offer)
                    .set({
                        status: "declined",
                        decidedAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.offer.id, offerId));
                return;
            }

            const contractId = createId("contract");

            await tx.insert(schema.contract).values({
                id: contractId,
                number: contractId,
                userId: row.userId,
                title: row.title,
                status: "provisioning",
                minimumTermMonths: row.minimumTermMonths,
                monthlyPriceCents: row.monthlyPriceCents,
                note: `Aus Angebot ${row.number} angenommen.`,
            });

            await tx
                .update(schema.offer)
                .set({
                    status: "accepted",
                    decidedAt: new Date(),
                    contractId,
                    updatedAt: new Date(),
                })
                .where(eq(schema.offer.id, offerId));
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        console.error("[offer] decision failed:", error);

        return {
            status: "error",
            message:
                reason === "expired"
                    ? "Dieses Angebot ist abgelaufen. Bitte sprich uns an."
                    : reason === "not-open"
                      ? "Dieses Angebot wurde bereits entschieden."
                      : "Das hat nicht geklappt. Bitte versuche es erneut.",
        };
    }

    revalidatePath("/account/offers");
    revalidatePath("/account/contracts");
    revalidatePath("/account");

    return { status: "done" };
}
