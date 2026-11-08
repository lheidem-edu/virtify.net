"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type ClientTicketState, closeAction, replyAction } from "../actions";

const INITIAL: ClientTicketState = { status: "idle" };

export default function ReplyForm({
    ticketId,
    closed,
}: {
    ticketId: string;
    closed: boolean;
}) {
    const [state, reply, pending] = useActionState(replyAction, INITIAL);
    const [closeState, close, closing] = useActionState(closeAction, INITIAL);

    return (
        <div className="max-w-xl space-y-6">
            <form action={reply} className="space-y-3">
                <input type="hidden" name="ticketId" value={ticketId} />
                <Textarea
                    name="body"
                    rows={6}
                    required
                    placeholder={
                        closed
                            ? "Eine Antwort öffnet das Ticket wieder."
                            : "Deine Antwort"
                    }
                />
                <Button type="submit" disabled={pending}>
                    {pending ? "Sende…" : "Antworten"}
                </Button>
                <FormStatus
                    tone={state.status === "error" ? "error" : "success"}
                    message={state.message}
                    variant="inline"
                />
            </form>

            {!closed ? (
                <form action={close}>
                    <input type="hidden" name="ticketId" value={ticketId} />
                    <Button type="submit" variant="outline" disabled={closing}>
                        {closing ? "Schließe…" : "Ticket schließen"}
                    </Button>
                    <FormStatus
                        tone={
                            closeState.status === "error" ? "error" : "success"
                        }
                        message={closeState.message}
                        variant="inline"
                    />
                </form>
            ) : null}
        </div>
    );
}
