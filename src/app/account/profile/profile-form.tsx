"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ProfileState, updateProfile } from "./actions";

const FIELDS = [
    { id: "name", label: "Name", required: true, autoComplete: "name" },
    {
        id: "company",
        label: "Firma (optional)",
        required: false,
        autoComplete: "organization",
    },
    {
        id: "street",
        label: "Straße und Hausnummer",
        required: false,
        autoComplete: "street-address",
    },
    {
        id: "postalCode",
        label: "Postleitzahl",
        required: false,
        autoComplete: "postal-code",
    },
    {
        id: "city",
        label: "Ort",
        required: false,
        autoComplete: "address-level2",
    },
    {
        id: "country",
        label: "Land",
        required: false,
        autoComplete: "country-name",
    },
    {
        id: "vatId",
        label: "USt-IdNr. (optional)",
        required: false,
        autoComplete: "off",
    },
    {
        id: "phone",
        label: "Telefon (optional)",
        required: false,
        autoComplete: "tel",
    },
] as const;

const initialState: ProfileState = { status: "idle" };

export default function ProfileForm({
    user,
}: {
    user: Record<(typeof FIELDS)[number]["id"], string>;
}) {
    const [state, formAction, pending] = useActionState(
        updateProfile,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-xl space-y-6">
            {state.status === "saved" ? (
                <p className="rounded-lg border p-4 text-sm leading-6 text-zinc-300">
                    Gespeichert.
                </p>
            ) : null}
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                    {state.message}
                </p>
            ) : null}

            {FIELDS.map((field) => (
                <div key={field.id} className="space-y-3">
                    <Label htmlFor={field.id}>{field.label}</Label>
                    <Input
                        id={field.id}
                        name={field.id}
                        defaultValue={user[field.id]}
                        required={field.required}
                        autoComplete={field.autoComplete}
                        maxLength={200}
                    />
                </div>
            ))}

            <Button
                type="submit"
                size="lg"
                disabled={pending}
                className="w-full sm:w-auto"
            >
                {pending ? "…" : "Speichern"}
            </Button>
        </form>
    );
}
