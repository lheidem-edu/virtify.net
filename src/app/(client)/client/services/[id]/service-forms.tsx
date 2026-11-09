"use client";

import { useActionState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import {
    openOwnConsole,
    revealOwnCredentials,
    runOwnAction,
    type ServiceActionState,
} from "../actions";

const IDLE: ServiceActionState = { status: "idle" };

export type Action = {
    id: string;
    label: string;
    description: string;
    destructive: boolean;
};

/**
 * The buttons.
 *
 * A destructive action goes behind a confirmation — a hard power-off loses
 * whatever the guest had not written out, and a reinstall loses everything —
 * while „Starten“ and „Herunterfahren“ are a click, because asking twice for
 * those is noise that teaches people to click through dialogs.
 *
 * Which actions exist at all comes from the **module**, through the server
 * component; this file renders what it is given and nothing more. The
 * authorisation is decided again in `requestServiceAction`, server-side, on
 * every press — the list here is a convenience.
 */
export function PowerActions({
    serviceId,
    actions,
    disabled,
    disabledReason,
}: {
    serviceId: string;
    actions: Action[];
    disabled: boolean;
    disabledReason: string | null;
}) {
    const [state, formAction, pending] = useActionState<
        ServiceActionState,
        FormData
    >(runOwnAction, IDLE);

    if (disabled) {
        return (
            <p className="text-sm text-muted-foreground">
                {disabledReason ??
                    "Für diese Leistung gibt es gerade keine Aktionen."}
            </p>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                {actions.map((action) =>
                    action.destructive ? (
                        <ConfirmAction
                            key={action.id}
                            action={runOwnAction}
                            initialState={IDLE}
                            fields={{ serviceId, action: action.id }}
                            label={action.label}
                            title={`${action.label}?`}
                            description={action.description}
                            confirmLabel={action.label}
                            confirmVariant="destructive"
                            variant="outline"
                            size="default"
                        />
                    ) : (
                        <form action={formAction} key={action.id}>
                            <input
                                type="hidden"
                                name="serviceId"
                                value={serviceId}
                            />
                            <input
                                type="hidden"
                                name="action"
                                value={action.id}
                            />
                            <Button
                                type="submit"
                                variant="outline"
                                disabled={pending}
                                title={action.description}
                            >
                                {action.label}
                            </Button>
                        </form>
                    ),
                )}
            </div>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
            />
        </div>
    );
}

/**
 * „Zugangsdaten anzeigen“.
 *
 * The password is not on the page until somebody asks for it, and asking is
 * written to the audit log. It is held in this component's state for the one
 * render and is gone on the next navigation — there is deliberately nothing
 * that puts it in a URL, in `localStorage` or in a server-rendered HTML
 * attribute.
 */
export function CredentialReveal({ serviceId }: { serviceId: string }) {
    const [state, formAction, pending] = useActionState<
        ServiceActionState,
        FormData
    >(revealOwnCredentials, IDLE);

    return (
        <div className="space-y-4">
            {state.credentials ? (
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                    <dt className="text-muted-foreground">Benutzer</dt>
                    <dd className="font-mono">{state.credentials.username}</dd>
                    <dt className="text-muted-foreground">Passwort</dt>
                    <dd className="font-mono break-all">
                        {state.credentials.password}
                    </dd>
                    {state.credentials.host ? (
                        <>
                            <dt className="text-muted-foreground">Adresse</dt>
                            <dd className="font-mono">
                                {state.credentials.host}
                            </dd>
                        </>
                    ) : null}
                </dl>
            ) : (
                <form action={formAction}>
                    <input type="hidden" name="serviceId" value={serviceId} />
                    <Button type="submit" variant="outline" disabled={pending}>
                        Zugangsdaten anzeigen
                    </Button>
                </form>
            )}
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
            />
            <p className="text-xs text-muted-foreground">
                Der Zugriff auf diese Daten wird protokolliert. Bitte ändere das
                Passwort nach der ersten Anmeldung.
            </p>
        </div>
    );
}

/**
 * The console.
 *
 * What comes back is a connection — a websocket address and a ticket that is
 * good for about two minutes. **A viewer is not bundled**: a noVNC client
 * would be a new dependency (rule 12) and a built-in one would need a
 * websocket proxy route of its own, which is a decision rather than a
 * detail. Until then this hands over the address, which an operator with
 * their own client can use.
 */
export function ConsoleButton({ serviceId }: { serviceId: string }) {
    const [state, formAction, pending] = useActionState<
        ServiceActionState,
        FormData
    >(openOwnConsole, IDLE);

    return (
        <div className="space-y-3">
            <form action={formAction}>
                <input type="hidden" name="serviceId" value={serviceId} />
                <Button type="submit" variant="outline" disabled={pending}>
                    Konsolen-Zugang anfordern
                </Button>
            </form>
            {state.console ? (
                <p className="font-mono text-xs break-all text-muted-foreground">
                    {state.console.url}
                </p>
            ) : null}
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
            />
        </div>
    );
}
