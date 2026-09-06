"use client";

import { useActionState, useEffect, useState } from "react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import FormStatus from "@/lib/components/account/form-status";

export type ConfirmState = { status: string; message?: string };

/**
 * A server action behind a confirmation. Anything that cannot be undone by
 * clicking again — deleting a draft, cancelling an issued invoice, pulling an
 * offer back — goes through here rather than a bare button in a table row.
 *
 * The dialog stays open until the action has settled: a failure message is
 * only useful where the click happened, and there is no toast in this app.
 */
export default function ConfirmAction<S extends ConfirmState>({
    action,
    initialState,
    fields,
    label,
    title,
    description,
    confirmLabel,
    children,
    variant = "ghost",
    size = "sm",
    confirmVariant = "default",
}: {
    // Awaited<S> rather than S so useActionState can prove the state is not
    // itself a promise; for a plain state object the two are the same type.
    action: (previous: Awaited<S>, data: FormData) => Promise<S>;
    initialState: Awaited<S>;
    /** Hidden inputs the action needs, usually the row id. */
    fields: Record<string, string>;
    label: string;
    title: string;
    description: string;
    confirmLabel: string;
    /** Extra inputs rendered above the buttons, e.g. a date to terminate to. */
    children?: React.ReactNode;
    variant?: React.ComponentProps<typeof Button>["variant"];
    size?: React.ComponentProps<typeof Button>["size"];
    confirmVariant?: React.ComponentProps<typeof Button>["variant"];
}) {
    const [open, setOpen] = useState(false);
    const [state, formAction, pending] = useActionState<S, FormData>(
        action,
        initialState,
    );

    useEffect(() => {
        if (state.status !== "idle" && state.status !== "error") {
            setOpen(false);
        }
    }, [state]);

    return (
        <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger
                render={<Button variant={variant} size={size} />}
            >
                {label}
            </AlertDialogTrigger>
            <AlertDialogContent>
                <form action={formAction} className="grid gap-4">
                    {Object.entries(fields).map(([name, value]) => (
                        <input
                            key={name}
                            type="hidden"
                            name={name}
                            value={value}
                        />
                    ))}

                    <AlertDialogHeader>
                        <AlertDialogTitle>{title}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {description}
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    {children ? (
                        <div className="space-y-3 text-left">{children}</div>
                    ) : null}

                    {state.status === "error" ? (
                        <FormStatus
                            tone="error"
                            message={state.message}
                            variant="inline"
                        />
                    ) : null}

                    <AlertDialogFooter>
                        <AlertDialogCancel type="button">
                            Abbrechen
                        </AlertDialogCancel>
                        <AlertDialogAction
                            type="submit"
                            variant={confirmVariant}
                            disabled={pending}
                        >
                            {pending ? "…" : confirmLabel}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </form>
            </AlertDialogContent>
        </AlertDialog>
    );
}
