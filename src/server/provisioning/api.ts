import "server-only";
import { z } from "zod";
import { SERVICE_ACTIONS, STAFF_ONLY_ACTIONS } from "./actions";
import type { LoadedService, ServiceListRow } from "./repository";
import type { AssignedAddress } from "./types";

/**
 * What a service looks like from outside: snake_case, instants as ISO-8601
 * in UTC.
 *
 * Beside the service rather than in the route, so the API, the tests and
 * anything else that has to speak the wire shape agree on one definition of
 * it — the same arrangement `src/server/subscriptions/api.ts` uses.
 *
 * **Credentials are never on the wire here.** The password a service was
 * built with is behind `revealCredentials`, which audits the read (rule 8);
 * putting it in the ordinary representation would mean every `GET
 * /api/v1/services` logged nothing and handed out every password the
 * customer owns.
 */

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export const serviceActionParamSchema = z.object({
    action: z.enum(SERVICE_ACTIONS),
});

export const serviceListQuerySchema = z.object({
    status: z
        .enum(["pending", "provisioning", "active", "suspended", "terminated"])
        .optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    include_terminated: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
});

export { STAFF_ONLY_ACTIONS };

function serializeAddress(address: AssignedAddress) {
    return {
        id: address.id,
        family: address.family,
        address: address.address,
        prefix_length: address.prefixLength,
        gateway: address.gateway,
        nameservers: address.nameservers,
        rdns: address.rdns,
    };
}

export function serializeServiceRow(row: ServiceListRow) {
    return {
        id: row.id,
        label: row.label,
        status: row.status,
        module: row.module,
        module_label: row.moduleLabel,
        customer_id: row.customerId,
        product_id: row.productId,
        subscription_id: row.subscriptionId,
        hostname: row.hostname,
        primary_address: row.primaryAddress,
        provider_status: row.providerStatus,
        provider_status_at: iso(row.providerStatusAt),
        activated_at: iso(row.activatedAt),
        suspended_at: iso(row.suspendedAt),
        terminated_at: iso(row.terminatedAt),
    };
}

export function serializeService(
    loaded: LoadedService,
    options: { staff: boolean },
) {
    const { service } = loaded;

    return {
        id: service.id,
        label: service.label,
        status: service.status,
        module: service.module,
        module_label: loaded.moduleLabel,
        customer_id: service.customerId,
        product_id: service.productId,
        subscription_id: loaded.subscriptionId,
        subscription_status: loaded.subscriptionStatus,
        hostname: service.hostname,
        addresses: loaded.addresses.map(serializeAddress),
        /**
         * The provider's own reading, beside the status rather than instead
         * of it — and `mismatch` says in German when the two disagree. See
         * `src/server/provisioning/runner.ts` on why a reading is never
         * written into `status`.
         */
        provider_status: service.providerStatus,
        provider_status_at: iso(service.providerStatusAt),
        provider_status_detail: service.providerStatusDetail,
        mismatch: loaded.mismatch,
        available_actions: loaded.clientActions.map((action) => ({
            id: action.id,
            label: action.label,
            description: action.description,
            destructive: action.destructive ?? false,
        })),
        activated_at: iso(service.activatedAt),
        suspended_at: iso(service.suspendedAt),
        terminated_at: iso(service.terminatedAt),
        /**
         * Which cluster, which VMID and what the queue has been doing are
         * the operator's business. A customer key gets none of it: the
         * provider's id is an invitation to go looking, and the task log
         * names internal failures in words a customer cannot act on.
         */
        ...(options.staff
            ? {
                  server_id: service.serverId,
                  server_name: loaded.serverName,
                  external_id: loaded.externalId,
                  module_data: service.moduleData,
                  tasks: loaded.tasks.map((task) => ({
                      id: task.id,
                      action: task.action,
                      request_key: task.requestKey,
                      status: task.status,
                      attempts: task.attempts,
                      max_attempts: task.maxAttempts,
                      provider_called_at: iso(task.providerCalledAt),
                      last_error: task.lastError,
                      result: task.result,
                      requested_by: task.requestedBy,
                      created_at: iso(task.createdAt),
                      finished_at: iso(task.finishedAt),
                  })),
              }
            : {}),
    };
}

export function serializeActionResult(input: {
    taskId: string | null;
    ok: boolean;
    summary: string;
    warnings: string[];
    alreadyDone: boolean;
    terminal: boolean;
}) {
    return {
        task_id: input.taskId,
        ok: input.ok,
        /**
         * True when there was nothing to do because it was already so — a VM
         * that already exists, a machine that is already off. An already-done
         * is a **success**, and saying so separately is what keeps a client
         * from reporting "gestartet" for a machine that was running.
         */
        already_done: input.alreadyDone,
        /** Nothing further will be tried automatically. */
        terminal: input.terminal,
        summary: input.summary,
        warnings: input.warnings,
    };
}
