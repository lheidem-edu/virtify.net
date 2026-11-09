"use client";

import { useActionState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    addPoolAddresses,
    type ProvisioningSettingsState,
    removeServer,
    savePool,
    saveServer,
    testServer,
} from "./actions";

const IDLE: ProvisioningSettingsState = { status: "idle" };

function Status({ state }: { state: ProvisioningSettingsState }) {
    return (
        <FormStatus
            tone={state.status === "error" ? "error" : "success"}
            message={state.message}
        />
    );
}

function Field({
    name,
    label,
    hint,
    defaultValue,
    placeholder,
    type = "text",
}: {
    name: string;
    label: string;
    hint?: string;
    defaultValue?: string | number | null;
    placeholder?: string;
    type?: string;
}) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={name}>{label}</Label>
            <Input
                id={name}
                name={name}
                type={type}
                defaultValue={defaultValue ?? ""}
                placeholder={placeholder}
            />
            {hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

export type ServerValues = {
    id: string;
    name: string;
    hostname: string | null;
    enabled: boolean;
    maxServices: number | null;
    note: string | null;
    hasToken: boolean;
    config: Record<string, unknown>;
};

/**
 * One server.
 *
 * The token fields are always empty, in both directions: nothing is rendered
 * back out (hard rule 6 keeps it encrypted and this page is not going to be
 * the one place it is plain text), and leaving them empty on a save means
 * "keep what is stored". Both have to be filled together — a token id
 * without a secret is a credential that cannot work.
 */
export function ServerForm({ values }: { values?: ServerValues }) {
    const [state, formAction, pending] = useActionState<
        ProvisioningSettingsState,
        FormData
    >(saveServer, IDLE);
    const config = values?.config ?? {};
    const s = (key: string) => {
        const value = config[key];

        return value === undefined || value === null ? "" : String(value);
    };

    return (
        <form action={formAction} className="space-y-6">
            {values ? (
                <input type="hidden" name="id" value={values.id} />
            ) : (
                <input type="hidden" name="module" value="proxmox" />
            )}

            <div className="grid gap-4 md:grid-cols-2">
                <Field
                    name="name"
                    label="Name"
                    defaultValue={values?.name}
                    placeholder="pve-fra-1"
                />
                <Field
                    name="hostname"
                    label="Host"
                    defaultValue={values?.hostname}
                    placeholder="pve1.virtify.net"
                />
                <Field
                    name="apiUrl"
                    label="API-Adresse"
                    defaultValue={s("apiUrl")}
                    placeholder="https://pve1.virtify.net:8006"
                    hint="Muss https sein und ein Zertifikat ausliefern, dem Node vertraut — bei einem selbst signierten Cluster-Zertifikat gehört dessen CA in NODE_EXTRA_CA_CERTS."
                />
                <Field
                    name="templateNode"
                    label="Knoten der Vorlage"
                    defaultValue={s("templateNode")}
                    placeholder="pve1"
                />
                <Field
                    name="templateVmid"
                    label="VMID der Vorlage"
                    defaultValue={s("templateVmid")}
                    placeholder="9000"
                />
                <Field
                    name="storage"
                    label="Speicher"
                    defaultValue={s("storage")}
                    placeholder="local-zfs"
                    hint="Leer lassen heißt: wie die Vorlage."
                />
                <Field
                    name="bridge"
                    label="Bridge"
                    defaultValue={s("bridge") || "vmbr0"}
                />
                <Field
                    name="vlanTag"
                    label="VLAN"
                    defaultValue={s("vlanTag")}
                    placeholder="optional"
                />
                <Field
                    name="diskBus"
                    label="Datenträger"
                    defaultValue={s("diskBus") || "scsi0"}
                    hint="Der Datenträger, der beim Anlegen auf die bestellte Größe wächst."
                />
                <Field
                    name="searchDomain"
                    label="Suchdomäne"
                    defaultValue={s("searchDomain")}
                    placeholder="virtify.net"
                />
                <Field
                    name="nodes"
                    label="Erlaubte Knoten"
                    defaultValue={(config.nodes as string[] | undefined)?.join(
                        " ",
                    )}
                    hint="Leer heißt: jeder Knoten, der online ist."
                />
                <Field
                    name="excludeNodes"
                    label="Ausgeschlossene Knoten"
                    defaultValue={(
                        config.excludeNodes as string[] | undefined
                    )?.join(" ")}
                />
                <Field
                    name="pool"
                    label="Proxmox-Pool"
                    defaultValue={s("pool")}
                    placeholder="optional"
                />
                <Field
                    name="maxServices"
                    label="Höchstzahl Leistungen"
                    defaultValue={values?.maxServices}
                    hint="Leer heißt: so viele, wie hineinpassen. Der Cluster wird beim Anlegen ohnehin nach freiem Arbeitsspeicher gefragt."
                />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Field
                    name="tokenId"
                    label="API-Token-ID"
                    placeholder="panel@pve!billing"
                    hint={
                        values?.hasToken
                            ? "Hinterlegt. Leer lassen, um ihn so zu belassen."
                            : "Noch keiner hinterlegt."
                    }
                />
                <Field
                    name="tokenSecret"
                    label="API-Token-Secret"
                    type="password"
                    hint="Wird verschlüsselt gespeichert und nie wieder angezeigt."
                />
            </div>

            <div className="flex flex-wrap items-center gap-6 text-sm">
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={values?.enabled ?? true}
                    />
                    Aktiv
                </label>
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        name="lockOnSuspend"
                        defaultChecked={Boolean(config.lockOnSuspend)}
                    />
                    Beim Sperren zusätzlich `lock` setzen
                </label>
            </div>
            <p className="max-w-2xl text-xs text-muted-foreground">
                Gesperrt wird ohnehin durch Stoppen und Abmelden vom Hoststart.
                `lock` darf auf einer normalen Installation nur `root@pam`
                setzen — mit einem eingeschränkten Token scheitert es, und das
                wird als Hinweis am Auftrag vermerkt, nicht als Fehler.
            </p>

            <Field name="note" label="Notiz" defaultValue={values?.note} />

            <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                    {values ? "Speichern" : "Server anlegen"}
                </Button>
            </div>
            <Status state={state} />
        </form>
    );
}

export function ServerActions({ id, name }: { id: string; name: string }) {
    const [state, formAction, pending] = useActionState<
        ProvisioningSettingsState,
        FormData
    >(testServer, IDLE);

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <form action={formAction}>
                    <input type="hidden" name="id" value={id} />
                    <Button
                        type="submit"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                    >
                        Verbindung prüfen
                    </Button>
                </form>
                <ConfirmAction
                    action={removeServer}
                    initialState={IDLE}
                    fields={{ id }}
                    label="Entfernen"
                    title={`„${name}“ entfernen?`}
                    description="Der Server wird nur noch nicht mehr ausgewählt; Leistungen, die darauf liegen, behalten ihren Verweis. Solange noch welche darauf liegen, lässt er sich nicht entfernen."
                    confirmLabel="Entfernen"
                    confirmVariant="destructive"
                />
            </div>
            <Status state={state} />
        </div>
    );
}

export function PoolForm({
    servers,
}: {
    servers: { id: string; name: string }[];
}) {
    const [state, formAction, pending] = useActionState<
        ProvisioningSettingsState,
        FormData
    >(savePool, IDLE);

    return (
        <form action={formAction} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
                <Field name="name" label="Name" placeholder="FRA /29" />
                <div className="space-y-1.5">
                    <Label htmlFor="family">Familie</Label>
                    <select
                        id="family"
                        name="family"
                        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                        defaultValue="ipv4"
                    >
                        <option value="ipv4">IPv4</option>
                        <option value="ipv6">IPv6</option>
                    </select>
                </div>
                <Field
                    name="prefixLength"
                    label="Maske (Bit)"
                    placeholder="24"
                />
                <Field name="gateway" label="Gateway" placeholder="192.0.2.1" />
                <Field
                    name="cidr"
                    label="Bereich"
                    placeholder="192.0.2.0/24"
                    hint="Nur zur Dokumentation — vergeben wird aus den eingetragenen Adressen."
                />
                <Field
                    name="nameservers"
                    label="Nameserver"
                    placeholder="9.9.9.9 149.112.112.112"
                />
                <div className="space-y-1.5">
                    <Label htmlFor="serverId">Server</Label>
                    <select
                        id="serverId"
                        name="serverId"
                        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                        defaultValue=""
                    >
                        <option value="">Jeder Server</option>
                        {servers.map((server) => (
                            <option key={server.id} value={server.id}>
                                {server.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="enabled" defaultChecked />
                Aktiv
            </label>
            <Button type="submit" disabled={pending}>
                Pool anlegen
            </Button>
            <Status state={state} />
        </form>
    );
}

export function AddressForm({ poolId }: { poolId: string }) {
    const [state, formAction, pending] = useActionState<
        ProvisioningSettingsState,
        FormData
    >(addPoolAddresses, IDLE);

    return (
        <form action={formAction} className="space-y-3">
            <input type="hidden" name="poolId" value={poolId} />
            <Field
                name="addresses"
                label="Adressen"
                placeholder="192.0.2.10 192.0.2.11 192.0.2.12"
                hint="Durch Leerzeichen, Komma oder Zeilenumbruch getrennt. Doppelte werden übersprungen, nicht abgelehnt."
            />
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="reserved" />
                Zurückhalten (nicht vergeben)
            </label>
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                Aufnehmen
            </Button>
            <Status state={state} />
        </form>
    );
}
