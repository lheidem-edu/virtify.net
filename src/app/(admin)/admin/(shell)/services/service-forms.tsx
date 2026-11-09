"use client";

import { useActionState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    type AdminServiceState,
    retryTask,
    revealServiceCredentials,
    runPassNow,
    runServiceAction,
    setAddressRdns,
} from "./actions";

const IDLE: AdminServiceState = { status: "idle" };

function Status({ state }: { state: AdminServiceState }) {
    return (
        <FormStatus
            tone={state.status === "error" ? "error" : "success"}
            message={state.message}
        />
    );
}

/**
 * The lifecycle buttons.
 *
 * Everything that cannot be undone by clicking again — tearing a machine
 * down, reinstalling it — goes behind a confirmation. „Einrichten“ does not,
 * because it is keyed `"create"` for ever: pressing it twice is one machine,
 * which is the whole point of the reserved VMID.
 */
export function LifecycleActions({
    serviceId,
    status,
}: {
    serviceId: string;
    status: string;
}) {
    const [state, formAction, pending] = useActionState<
        AdminServiceState,
        FormData
    >(runServiceAction, IDLE);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                {status === "pending" || status === "provisioning" ? (
                    <form action={formAction}>
                        <input
                            type="hidden"
                            name="serviceId"
                            value={serviceId}
                        />
                        <input type="hidden" name="action" value="provision" />
                        <Button type="submit" disabled={pending}>
                            Jetzt einrichten
                        </Button>
                    </form>
                ) : null}

                {status === "active" ? (
                    <ConfirmAction
                        action={runServiceAction}
                        initialState={IDLE}
                        fields={{ serviceId, action: "suspend" }}
                        label="Sperren"
                        title="Leistung sperren?"
                        description="Die Maschine wird gestoppt und vom Hoststart abgemeldet. Die Abrechnung ändert sich dadurch nicht."
                        confirmLabel="Sperren"
                        variant="outline"
                        size="default"
                    />
                ) : null}

                {status === "suspended" ? (
                    <ConfirmAction
                        action={runServiceAction}
                        initialState={IDLE}
                        fields={{ serviceId, action: "unsuspend" }}
                        label="Entsperren"
                        title="Leistung entsperren?"
                        description="Die Maschine wird wieder gestartet. Prüfe vorher, ob die offene Rechnung wirklich ausgeglichen ist — der Mahnlauf sperrt sonst gleich wieder."
                        confirmLabel="Entsperren"
                        variant="outline"
                        size="default"
                    />
                ) : null}

                {status !== "terminated" ? (
                    <ConfirmAction
                        action={runServiceAction}
                        initialState={IDLE}
                        fields={{ serviceId, action: "terminate" }}
                        label="Abbauen"
                        title="Leistung abbauen?"
                        description="Die Maschine wird gelöscht, die IP-Adressen gehen zurück in den Pool und der PTR-Eintrag wird entfernt. Das lässt sich nicht rückgängig machen."
                        confirmLabel="Abbauen"
                        confirmVariant="destructive"
                        variant="outline"
                        size="default"
                    />
                ) : null}

                {status === "active" || status === "suspended" ? (
                    <form action={formAction}>
                        <input
                            type="hidden"
                            name="serviceId"
                            value={serviceId}
                        />
                        <input type="hidden" name="action" value="sync" />
                        <Button
                            type="submit"
                            variant="ghost"
                            disabled={pending}
                        >
                            Stand abrufen
                        </Button>
                    </form>
                ) : null}
            </div>
            <Status state={state} />
        </div>
    );
}

export function AdminCredentialReveal({ serviceId }: { serviceId: string }) {
    const [state, formAction, pending] = useActionState<
        AdminServiceState,
        FormData
    >(revealServiceCredentials, IDLE);

    return (
        <div className="space-y-3">
            {state.credentials ? (
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                    {Object.entries(state.credentials).map(([key, value]) => (
                        <div key={key} className="contents">
                            <dt className="text-muted-foreground">{key}</dt>
                            <dd className="font-mono break-all">{value}</dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <form action={formAction}>
                    <input type="hidden" name="serviceId" value={serviceId} />
                    <Button type="submit" variant="outline" disabled={pending}>
                        Zugangsdaten anzeigen
                    </Button>
                </form>
            )}
            <Status state={state} />
            <p className="text-xs text-muted-foreground">
                Dieser Zugriff steht im Protokoll — mit deinem Namen, der
                Leistung und den Feldern, nie mit dem Passwort selbst.
            </p>
        </div>
    );
}

export function RetryTaskButton({
    taskId,
    serviceId,
}: {
    taskId: string;
    serviceId: string;
}) {
    const [state, formAction, pending] = useActionState<
        AdminServiceState,
        FormData
    >(retryTask, IDLE);

    return (
        <form action={formAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="taskId" value={taskId} />
            <input type="hidden" name="serviceId" value={serviceId} />
            <Button type="submit" variant="ghost" size="sm" disabled={pending}>
                Erneut versuchen
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}

export function RunPassButton() {
    const [state, formAction, pending] = useActionState<
        AdminServiceState,
        FormData
    >(runPassNow, IDLE);

    return (
        <div className="space-y-3">
            <form action={formAction}>
                <Button type="submit" variant="outline" disabled={pending}>
                    Jetzt ausführen
                </Button>
            </form>
            <Status state={state} />
            <p className="text-xs text-muted-foreground">
                Derselbe Durchlauf, den der Worker jede Minute macht. Gefahrlos
                — jede Anfrage wird vorher beansprucht, also kann nichts doppelt
                passieren.
            </p>
        </div>
    );
}

export function RdnsForm({
    addressId,
    serviceId,
    address,
    rdns,
}: {
    addressId: string;
    serviceId: string;
    address: string;
    rdns: string | null;
}) {
    const [state, formAction, pending] = useActionState<
        AdminServiceState,
        FormData
    >(setAddressRdns, IDLE);

    return (
        <form action={formAction} className="space-y-2">
            <input type="hidden" name="addressId" value={addressId} />
            <input type="hidden" name="serviceId" value={serviceId} />
            <div className="flex flex-wrap items-center gap-2">
                <span className="w-48 font-mono text-sm">{address}</span>
                <Input
                    name="rdns"
                    defaultValue={rdns ?? ""}
                    placeholder="vps-17.virtify.net"
                    className="max-w-xs"
                />
                <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    PTR setzen
                </Button>
            </div>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
