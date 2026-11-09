import type { ZodType } from "zod";
import type {
    IpFamily,
    ProvisioningResource,
    ProvisioningServer,
    Service,
} from "@/db/schema";

/**
 * What a provisioning module is.
 *
 * A product names one, and the module decides what `product.module_config`
 * and `provisioning_server.config` may contain — the schemas live with the
 * module rather than in the catalog, so adding a second module adds a
 * directory and touches neither the product form nor the database.
 *
 * **A module never touches the database.** Everything it is allowed to
 * change about the panel's own records is a function on the context it is
 * handed: reserving the provider id, allocating an address, writing the
 * credentials. That is not politeness — it is what keeps the two rules this
 * phase lives or dies by in one place:
 *
 *  - a retry must not make a second VM (`reserveResource` is idempotent and
 *    keyed on the provider's own id), and
 *  - a create that failed before the provider was ever asked gives back
 *    exactly what it took, while one that failed afterwards keeps it
 *    (`markProviderCalled`, which the module calls immediately before its
 *    first request).
 *
 * The module's own job is to talk to the provider and to be honest about
 * what came back.
 */

/** A provider's reading of the machine. Never written to `service.status`. */
export type ProviderState = "running" | "stopped" | "suspended" | "unknown";

export type ProviderStatus = {
    state: ProviderState;
    /** One line for a person: an uptime, a lock, "existiert nicht (mehr)". */
    detail: string | null;
    /** True when the provider says there is no such machine. */
    missing?: boolean;
    /** Anything worth putting on `service.module_data`. */
    data?: Record<string, unknown>;
};

export type ModuleResult = {
    /** What to record on the task, and what a person reads on the page. */
    summary: string;
    /**
     * True when nothing had to be done because it was already so — a VM that
     * already exists, a machine that is already stopped. **An already-done is
     * a success**, and saying so separately is what keeps the retry of a
     * create that half went through from reading as a fresh provisioning.
     */
    alreadyDone?: boolean;
    data?: Record<string, unknown>;
    /**
     * Something that did not work but is not a failure of the action — a
     * `lock` an unprivileged token may not set. Recorded and shown, never
     * thrown.
     */
    warnings?: string[];
};

export type AssignedAddress = {
    id: string;
    poolId: string;
    family: IpFamily;
    address: string;
    prefixLength: number;
    gateway: string | null;
    nameservers: string[];
    rdns: string | null;
};

export type AllocateRequest = {
    family: IpFamily;
    count: number;
    /** A specific pool, or null to take any enabled pool for this server. */
    poolId?: string | null;
};

export type ModuleContext<Config = unknown, ServerConfig = unknown> = {
    service: Service;
    /** `product.module_config`, parsed by `configSchema`. */
    config: Config;
    server: {
        row: ProvisioningServer;
        /** `provisioning_server.config`, parsed by `serverSchema`. */
        config: ServerConfig;
        /** The decrypted API token. Never logged, never put on a task. */
        credentials: Record<string, string>;
    };
    /** The provider id reserved for this service, where one has been. */
    resource: ProvisioningResource | null;
    /** The addresses this service holds right now. */
    addresses: AssignedAddress[];
    /** What the caller asked for: `{ power: "reboot" }`, a target package. */
    payload: Record<string, unknown>;
    now: Date;

    /**
     * Injected in tests; the recorded payloads live in
     * `tests/helpers/proxmox.ts`. Deliberately on the context and not in
     * `payload`, which is a jsonb column and cannot hold a function.
     */
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;

    /**
     * Called **immediately before the first request that can change
     * anything at the provider** — the clone, not the `GET /nodes` that
     * chose where to put it. See the header: it is the line between
     * "nothing can exist" and "something might", and it is what an abort
     * consults before giving anything back.
     */
    markProviderCalled(): Promise<void>;

    /**
     * Reserves the provider's own id for this service, or hands back the one
     * that is already reserved. Idempotent by the unique index on
     * `provisioning_resource (server_id, kind, external_id)` and on
     * `(service_id)`.
     */
    reserveResource(input: {
        kind: string;
        /** A function, so a provider id is only drawn when none is reserved. */
        nextId: () => Promise<string>;
        node?: string | null;
    }): Promise<ProvisioningResource>;

    /** Records that the provider has confirmed the machine exists. */
    confirmResource(node?: string | null): Promise<void>;

    /**
     * Takes addresses out of a pool for this service. Idempotent in the
     * sense that matters: it tops the service up to `count` of that family
     * rather than adding `count` more, so a retried create does not walk a
     * pool down one address per attempt.
     *
     * There is deliberately **no** `release` on this context. Giving things
     * back is the runner's job and happens in exactly two places
     * (`src/server/provisioning/runner.ts`): a successful `terminate`, and
     * an abort that never reached the provider. A module that could release
     * would be a second answer to "whose address is this", and the one that
     * was wrong would be the one that handed a running machine's address to
     * the next customer.
     */
    allocateAddresses(request: AllocateRequest): Promise<AssignedAddress[]>;

    /** Stored AES-256-GCM (rule 6). Replaces whatever was there. */
    setCredentials(value: Record<string, string>): Promise<void>;
    readCredentials(): Promise<Record<string, string> | null>;

    /** Merged into `service.module_data`. */
    patchModuleData(patch: Record<string, unknown>): Promise<void>;

    /** Put on the task's record, not in the application log. */
    log(message: string): void;
};

/** An action the *customer* may trigger from their own service page. */
export type ClientAction = {
    id: string;
    label: string;
    description: string;
    /**
     * Whether it destroys data. A destructive action is typed-to-confirm in
     * the portal and never retried automatically.
     */
    destructive?: boolean;
};

export type ConnectionCheck = {
    ok: boolean;
    /** German, shown on the server form. */
    detail: string;
};

export type ConsoleTicket = {
    /** Where a viewer would connect. */
    websocketUrl: string;
    ticket: string;
    port: string;
    expiresAt: Date;
    /** The provider's own web console, for an operator who is signed in there. */
    providerUrl: string | null;
};

export interface ProvisioningModule<Config = unknown, ServerConfig = unknown> {
    /** Stored in `product.module`. Stable: it is a value in the database. */
    readonly id: string;
    /** German, shown in the product form. */
    readonly label: string;
    readonly description: string;
    /**
     * Validates and normalises `product.module_config`. It has to accept the
     * empty object, because that is what a product carries the moment its
     * module is switched.
     */
    readonly configSchema: ZodType<Config>;
    /**
     * Validates `provisioning_server.config`. A module that puts nothing
     * anywhere — `none` — publishes a strict empty object, so a server row
     * cannot be made for it at all.
     */
    readonly serverSchema: ZodType<ServerConfig>;
    /** Whether ordering this product creates something to be provisioned. */
    readonly provisions: boolean;

    /** What the customer may press. Empty for a module with no live actions. */
    readonly clientActions?: readonly ClientAction[];

    create?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    suspend?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    unsuspend?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    terminate?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    changePackage?(
        ctx: ModuleContext<Config, ServerConfig>,
    ): Promise<ModuleResult>;
    /** `start` | `stop` | `shutdown` | `reboot`, in `payload.power`. */
    power?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    /** Destroys the machine and builds it again, keeping id and addresses. */
    reinstall?(ctx: ModuleContext<Config, ServerConfig>): Promise<ModuleResult>;
    getStatus?(
        ctx: ModuleContext<Config, ServerConfig>,
    ): Promise<ProviderStatus>;
    /**
     * A console ticket.
     *
     * Deliberately **not** a `ModuleContext` method: it changes nothing, it
     * is good for about two minutes, and it does not go through the task
     * queue at all — a credential that expires before the queue drains is a
     * button that never works. So it takes only what it needs.
     */
    console?(input: {
        server: { config: ServerConfig; credentials: Record<string, string> };
        resource: { externalId: string; node: string | null };
        now: Date;
        fetchImpl?: typeof fetch;
    }): Promise<ConsoleTicket | null>;

    testConnection?(input: {
        config: ServerConfig;
        credentials: Record<string, string>;
        fetchImpl?: typeof fetch;
    }): Promise<ConnectionCheck>;
}
