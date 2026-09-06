"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type ContractState, createContract } from "./actions";

const initialState: ContractState = { status: "idle" };

const selectClass =
    "w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export default function ContractForm({
    accounts,
}: {
    accounts: { id: string; name: string; email: string }[];
}) {
    const [state, formAction, pending] = useActionState(
        createContract,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-xl space-y-6">
            {state.status === "created" ? (
                <p className="rounded-lg border p-4 text-sm leading-6 text-zinc-300">
                    Angelegt:{" "}
                    <span className="font-mono break-all">{state.message}</span>
                </p>
            ) : null}
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                    {state.message}
                </p>
            ) : null}

            <div className="space-y-3">
                <Label htmlFor="userId">Konto</Label>
                {accounts.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                        Es gibt noch keine Konten, denen ein Vertrag zugeordnet
                        werden könnte.
                    </p>
                ) : (
                    <select
                        id="userId"
                        name="userId"
                        required
                        className={selectClass}
                        defaultValue=""
                    >
                        <option value="" disabled>
                            Bitte wählen
                        </option>
                        {accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                                {account.email}
                                {account.name ? ` — ${account.name}` : ""}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            <div className="space-y-3">
                <Label htmlFor="title">Bezeichnung</Label>
                <Input
                    id="title"
                    name="title"
                    placeholder="z. B. KVM-Instanz"
                    required
                />
            </div>

            <div className="space-y-3">
                <Label htmlFor="status">Status</Label>
                <select
                    id="status"
                    name="status"
                    className={selectClass}
                    defaultValue="provisioning"
                >
                    <option value="provisioning">In Bereitstellung</option>
                    <option value="active">Aktiv</option>
                    <option value="terminated">Gekündigt</option>
                    <option value="ended">Beendet</option>
                </select>
            </div>

            <div className="space-y-3">
                <Label htmlFor="monthlyPrice">
                    Monatliche Vergütung in EUR
                </Label>
                <Input
                    id="monthlyPrice"
                    name="monthlyPrice"
                    inputMode="decimal"
                    placeholder="9,95"
                    required
                />
                <p className="text-xs text-muted-foreground">
                    Ohne Umsatzsteuer (§ 19 UStG).
                </p>
            </div>

            <div className="space-y-3">
                <Label htmlFor="minimumTermMonths">
                    Grundlaufzeit in Monaten
                </Label>
                <Input
                    id="minimumTermMonths"
                    name="minimumTermMonths"
                    type="number"
                    min={0}
                    max={12}
                    defaultValue={12}
                    required
                />
            </div>

            <div className="space-y-3">
                <Label htmlFor="serviceReadyAt">Service-Readiness</Label>
                <Input id="serviceReadyAt" name="serviceReadyAt" type="date" />
            </div>

            <div className="space-y-3">
                <Label htmlFor="terminatedTo">Gekündigt zum</Label>
                <Input id="terminatedTo" name="terminatedTo" type="date" />
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Interne Notiz</Label>
                <Textarea id="note" name="note" rows={3} />
                <p className="text-xs text-muted-foreground">
                    Wird dem Kunden nicht angezeigt.
                </p>
            </div>

            <Button
                type="submit"
                size="lg"
                disabled={pending || accounts.length === 0}
                className="w-full sm:w-auto"
            >
                {pending ? "…" : "Vertrag anlegen"}
            </Button>
        </form>
    );
}
