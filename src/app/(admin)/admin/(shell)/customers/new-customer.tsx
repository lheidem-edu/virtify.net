"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { addCustomer } from "./actions";
import CustomerForm, { EMPTY_CUSTOMER } from "./customer-form";

/**
 * Folded away by default: the list is what this page is for, and an empty
 * nine-field form above it would push every account below the fold.
 */
export default function NewCustomer() {
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button variant="outline" onClick={() => setOpen(true)}>
                Neues Kundenkonto
            </Button>
        );
    }

    return (
        <div className="space-y-4">
            <p className="max-w-2xl text-sm text-muted-foreground">
                Ein Konto ohne Login — für die Übernahme eines Bestandskunden.
                Ein Zugang entsteht, sobald sich jemand mit der Adresse des
                Kontos registriert und als Kontakt hinterlegt wird.
            </p>
            <CustomerForm
                action={addCustomer}
                customer={EMPTY_CUSTOMER}
                submitLabel="Konto anlegen"
            />
            <Button variant="ghost" onClick={() => setOpen(false)}>
                Abbrechen
            </Button>
        </div>
    );
}
