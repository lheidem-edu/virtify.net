"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type ClientTicketState, createTicketAction } from "../actions";

const INITIAL: ClientTicketState = { status: "idle" };

export default function NewTicketForm({
    departments,
    email,
}: {
    departments: { id: string; label: string }[];
    email: string;
}) {
    const [state, action, pending] = useActionState(
        createTicketAction,
        INITIAL,
    );

    return (
        <form action={action} className="max-w-xl space-y-5">
            <SelectField
                id="departmentId"
                label="Abteilung"
                required
                options={departments.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                }))}
            />

            <div className="space-y-2">
                <Label htmlFor="subject">Betreff</Label>
                <Input id="subject" name="subject" required maxLength={200} />
            </div>

            <div className="space-y-2">
                <Label htmlFor="body">Nachricht</Label>
                <Textarea id="body" name="body" rows={10} required />
            </div>

            <p className="text-xs text-muted-foreground">
                Antworten gehen an {email}.
            </p>

            <Button type="submit" disabled={pending}>
                {pending ? "Sende…" : "Ticket eröffnen"}
            </Button>

            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
            />
        </form>
    );
}
