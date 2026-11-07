"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type CheckoutState, submitOrder } from "./actions";

/**
 * The checkout form.
 *
 * It collects three things and computes none of them: the billing address,
 * what was accepted, and how it is to be paid. Every figure beside it came
 * from the server, and the order the submit produces is priced again from
 * the catalog inside its own transaction.
 */

export type CheckoutFormProps = {
    customer: {
        kind: "private" | "company";
        name: string;
        company: string | null;
        street: string | null;
        postalCode: string | null;
        city: string | null;
        country: string | null;
        vatId: string | null;
        phone: string | null;
    };
    /** The fassung of the AGB that is being accepted, in words. */
    termsLabel: string;
};

const INITIAL: CheckoutState = { status: "idle" };

export default function CheckoutForm({
    customer,
    termsLabel,
}: CheckoutFormProps) {
    const [state, action, pending] = useActionState(submitOrder, INITIAL);
    const [kind, setKind] = useState(customer.kind);

    const isConsumer = kind === "private";

    return (
        <form action={action} className="space-y-10">
            <fieldset className="space-y-6">
                <legend className="text-sm font-medium tracking-tight">
                    Rechnungsanschrift
                </legend>

                <div className="flex flex-wrap gap-2">
                    {(
                        [
                            ["private", "Privatperson"],
                            ["company", "Firma"],
                        ] as const
                    ).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setKind(value)}
                            className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                                kind === value
                                    ? "border-ring text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <input type="hidden" name="kind" value={kind} />

                <div className="grid gap-6 sm:grid-cols-2">
                    <Field
                        name="name"
                        label="Name"
                        defaultValue={customer.name}
                        required
                    />
                    {kind === "company" ? (
                        <Field
                            name="company"
                            label="Firma"
                            defaultValue={customer.company ?? ""}
                        />
                    ) : null}
                    <Field
                        name="street"
                        label="Straße und Hausnummer"
                        defaultValue={customer.street ?? ""}
                        required
                    />
                    <Field
                        name="postalCode"
                        label="Postleitzahl"
                        defaultValue={customer.postalCode ?? ""}
                        required
                    />
                    <Field
                        name="city"
                        label="Ort"
                        defaultValue={customer.city ?? ""}
                        required
                    />
                    <Field
                        name="country"
                        label="Land (ISO, z. B. DE)"
                        defaultValue={customer.country ?? "DE"}
                        required
                    />
                    {kind === "company" ? (
                        <Field
                            name="vatId"
                            label="USt-IdNr. (optional)"
                            defaultValue={customer.vatId ?? ""}
                        />
                    ) : null}
                    <Field
                        name="phone"
                        label="Telefon (optional)"
                        defaultValue={customer.phone ?? ""}
                    />
                </div>
            </fieldset>

            <fieldset className="space-y-4 border-t pt-10">
                <legend className="text-sm font-medium tracking-tight">
                    Zahlungsart
                </legend>

                <label className="flex items-start gap-3 text-sm">
                    <input
                        type="radio"
                        name="paymentOption"
                        value="bank_transfer"
                        defaultChecked
                        className="mt-1 size-4"
                    />
                    <span>
                        Überweisung
                        <span className="block text-xs text-zinc-500">
                            Sie erhalten eine Rechnung mit Bankverbindung und
                            GiroCode. Kartenzahlung und PayPal folgen.
                        </span>
                    </span>
                </label>

                <label className="flex items-start gap-3 text-sm">
                    <input
                        type="checkbox"
                        name="autoCharge"
                        className="mt-1 size-4"
                    />
                    <span>
                        Wiederkehrende Beträge automatisch einziehen
                        <span className="block text-xs text-zinc-500">
                            Gilt erst, sobald ein Zahlungsmittel hinterlegt ist.
                            Die erste Rechnung wird in jedem Fall überwiesen.
                        </span>
                    </span>
                </label>
            </fieldset>

            <fieldset className="space-y-4 border-t pt-10">
                <legend className="text-sm font-medium tracking-tight">
                    Bestätigungen
                </legend>

                <label className="flex items-start gap-3 text-sm">
                    <input
                        type="checkbox"
                        name="acceptTerms"
                        className="mt-1 size-4"
                    />
                    <span>
                        Ich habe die{" "}
                        <Link
                            href="/terms"
                            target="_blank"
                            className="underline underline-offset-4"
                        >
                            Allgemeinen Geschäftsbedingungen
                        </Link>{" "}
                        gelesen und akzeptiere sie.
                        <span className="block text-xs text-zinc-500">
                            {termsLabel}
                        </span>
                    </span>
                </label>

                {isConsumer ? (
                    <>
                        <label className="flex items-start gap-3 text-sm">
                            <input
                                type="checkbox"
                                name="acceptWithdrawal"
                                className="mt-1 size-4"
                            />
                            <span>
                                Ich habe die{" "}
                                <Link
                                    href="/terms"
                                    target="_blank"
                                    className="underline underline-offset-4"
                                >
                                    Widerrufsbelehrung
                                </Link>{" "}
                                zur Kenntnis genommen.
                            </span>
                        </label>

                        <label className="flex items-start gap-3 text-sm">
                            <input
                                type="checkbox"
                                name="immediateStart"
                                className="mt-1 size-4"
                            />
                            <span>
                                Ich verlange ausdrücklich, dass vor Ablauf der
                                Widerrufsfrist mit der Leistung begonnen wird.
                                <span className="block text-xs text-zinc-500">
                                    Bei einem Widerruf schulde ich Wertersatz
                                    für das bis dahin Geleistete (§ 357 Abs. 8
                                    BGB).
                                </span>
                            </span>
                        </label>
                    </>
                ) : (
                    <p className="text-xs text-zinc-500">
                        Unternehmern steht kein Widerrufsrecht zu (§ 312g i. V.
                        m. § 13 BGB).
                    </p>
                )}
            </fieldset>

            {state.status === "error" ? (
                <p className="text-sm text-destructive">{state.message}</p>
            ) : null}

            <Button type="submit" disabled={pending} className="w-full">
                {pending ? "Wird bestellt …" : "Zahlungspflichtig bestellen"}
            </Button>
        </form>
    );
}

function Field({
    name,
    label,
    defaultValue,
    required,
}: {
    name: string;
    label: string;
    defaultValue: string;
    required?: boolean;
}) {
    return (
        <div className="space-y-2">
            <Label htmlFor={name}>{label}</Label>
            <Input
                id={name}
                name={name}
                defaultValue={defaultValue}
                required={required}
            />
        </div>
    );
}
