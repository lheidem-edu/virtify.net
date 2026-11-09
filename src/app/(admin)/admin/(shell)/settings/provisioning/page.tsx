import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listPools, poolCounts } from "@/server/provisioning/ip-pools";
import { listServers, serverLoad } from "@/server/provisioning/servers";
import {
    AddressForm,
    PoolForm,
    ServerActions,
    ServerForm,
} from "./provisioning-forms";

export const dynamic = "force-dynamic";

/**
 * The hypervisors and the address ranges.
 *
 * **There is no Proxmox cluster for this installation and no credentials
 * were gone looking for.** Everything here is expected to read "noch kein
 * Server" until an operator fills it in; `docs/proxmox-setup.md` says what
 * has to happen in the cluster first — in particular that the API token
 * should be a restricted one, which is also why suspension does not rely on
 * `lock`.
 *
 * The token is write-only: it is stored AES-256-GCM (hard rule 6) and this
 * page can say that something is stored, never what.
 */
export default async function Page() {
    await requirePermission("services.manage");

    const servers = await listServers(db);
    const pools = await listPools(db);

    const serverRows = await Promise.all(
        servers.map(async (server) => ({
            server,
            load: await serverLoad(db, server.id),
        })),
    );

    const poolRows = await Promise.all(
        pools.map(async (pool) => ({
            pool,
            counts: await poolCounts(db, pool.id),
        })),
    );

    return (
        <>
            <PageHeader
                title="Bereitstellung"
                intro="Wo Leistungen angelegt werden, und aus welchen Adressen sie bedient werden."
            />

            <div className="space-y-12 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-6">
                    <h2 className="text-sm font-medium">Server</h2>

                    {serverRows.length === 0 ? (
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            Noch kein Server hinterlegt. Ohne einen passiert
                            beim Bestellen eines Proxmox-Produkts nichts: die
                            Leistung bleibt „Wartet“, der Auftrag wird
                            abgebrochen, bevor irgendetwas am Cluster verlangt
                            wird, und der nächste Durchlauf fragt erneut.
                        </p>
                    ) : (
                        <div className="space-y-8">
                            {serverRows.map(({ server, load }) => (
                                <div
                                    key={server.id}
                                    className="space-y-4 rounded-lg border p-6"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="flex flex-wrap items-center gap-3">
                                            <span className="text-sm font-medium">
                                                {server.name}
                                            </span>
                                            <StatusBadge
                                                label={
                                                    server.enabled
                                                        ? "Aktiv"
                                                        : "Aus"
                                                }
                                                tone={
                                                    server.enabled
                                                        ? "positive"
                                                        : "muted"
                                                }
                                            />
                                            <span className="text-xs text-muted-foreground">
                                                {load} Leistung(en)
                                                {server.maxServices
                                                    ? ` von höchstens ${server.maxServices}`
                                                    : ""}
                                            </span>
                                            {server.credentialsEncrypted ? null : (
                                                <span className="text-xs text-destructive">
                                                    kein Token hinterlegt
                                                </span>
                                            )}
                                        </div>
                                        <ServerActions
                                            id={server.id}
                                            name={server.name}
                                        />
                                    </div>

                                    {server.lastCheckAt ? (
                                        <p
                                            className={`text-xs ${
                                                server.lastCheckOk
                                                    ? "text-muted-foreground"
                                                    : "text-destructive"
                                            }`}
                                        >
                                            Zuletzt geprüft{" "}
                                            {formatDateTime(server.lastCheckAt)}
                                            : {server.lastCheckDetail}
                                        </p>
                                    ) : null}

                                    <ServerForm
                                        values={{
                                            id: server.id,
                                            name: server.name,
                                            hostname: server.hostname,
                                            enabled: server.enabled,
                                            maxServices: server.maxServices,
                                            note: server.note,
                                            hasToken: Boolean(
                                                server.credentialsEncrypted,
                                            ),
                                            config: server.config as Record<
                                                string,
                                                unknown
                                            >,
                                        }}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="space-y-4 rounded-lg border border-dashed p-6">
                        <h3 className="text-sm font-medium">
                            Neuen Proxmox-Server anlegen
                        </h3>
                        <ServerForm />
                    </div>
                </section>

                <section className="space-y-6">
                    <h2 className="text-sm font-medium">IP-Pools</h2>

                    {poolRows.length === 0 ? (
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            Noch kein Pool. Ein Produkt, das eine Adresse
                            verlangt, wird ohne einen nicht eingerichtet — und
                            zwar bevor am Cluster irgendetwas passiert, sodass
                            nichts halb entsteht.
                        </p>
                    ) : (
                        <div className="space-y-6">
                            {poolRows.map(({ pool, counts }) => (
                                <div
                                    key={pool.id}
                                    className="space-y-4 rounded-lg border p-6"
                                >
                                    <div className="flex flex-wrap items-center gap-3">
                                        <span className="text-sm font-medium">
                                            {pool.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {pool.family} /{pool.prefixLength}
                                            {pool.gateway
                                                ? ` · Gateway ${pool.gateway}`
                                                : ""}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {counts.free} frei von{" "}
                                            {counts.total}
                                            {counts.reserved > 0
                                                ? ` (${counts.reserved} zurückgehalten)`
                                                : ""}
                                        </span>
                                        <StatusBadge
                                            label={
                                                pool.enabled ? "Aktiv" : "Aus"
                                            }
                                            tone={
                                                pool.enabled
                                                    ? "positive"
                                                    : "muted"
                                            }
                                        />
                                    </div>
                                    <AddressForm poolId={pool.id} />
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="space-y-4 rounded-lg border border-dashed p-6">
                        <h3 className="text-sm font-medium">
                            Neuen Pool anlegen
                        </h3>
                        <PoolForm
                            servers={servers.map((server) => ({
                                id: server.id,
                                name: server.name,
                            }))}
                        />
                    </div>
                </section>
            </div>
        </>
    );
}
