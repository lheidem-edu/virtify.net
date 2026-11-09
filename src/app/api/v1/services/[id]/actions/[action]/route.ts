import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json, notFound, problem } from "@/server/api/respond";
import {
    requestServiceAction,
    ServiceActionError,
} from "@/server/provisioning/actions";
import {
    serializeActionResult,
    serviceActionParamSchema,
} from "@/server/provisioning/api";
import { ProvisioningInputError } from "@/server/provisioning/proxmox/sanitize";
import { ANY_CUSTOMER } from "@/server/provisioning/repository";

export const dynamic = "force-dynamic";

/**
 * Löst eine Aktion auf einer Leistung aus.
 *
 * **The same function the buttons in the portal call.** A power action is a
 * side effect on somebody's running machine, so having the route and the
 * server action each decide for themselves who may do what would be two
 * answers to one question — `requestServiceAction` is the only one.
 *
 * It runs the call rather than queueing it, so the answer says what actually
 * happened. The claim underneath is what makes that safe beside a worker
 * sweeping the same table.
 *
 * `already_done: true` is a **success**: the machine was already running, or
 * already off.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string; action: string }> },
) {
    const auth = await authenticate(request, "services.write");

    if (!auth.ok) {
        return auth.response;
    }

    const { id, action } = await params;
    const parsed = serviceActionParamSchema.safeParse({ action });

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const own = scopedCustomerId(auth.context);

    try {
        const result = await requestServiceAction(db, {
            serviceId: id,
            customer: own ?? ANY_CUSTOMER,
            action: parsed.data.action,
            asCustomer: own !== null,
            actor: {
                type: "api",
                id: auth.context.key.id,
                label: auth.context.key.prefix,
            },
        });

        if (!result.outcome) {
            return notFound();
        }

        if (!result.outcome.ran) {
            /**
             * The claim was not taken: another pass has it, or the request
             * is out of attempts. Either way nothing happened, and 409 says
             * so without pretending it did.
             */
            return problem(
                409,
                "Aktion nicht ausgeführt",
                result.outcome.reason === "not-claimable"
                    ? "Diese Anfrage wird bereits bearbeitet oder hat ihre Versuche aufgebraucht."
                    : result.outcome.reason,
            );
        }

        const body = serializeActionResult({
            taskId: result.taskId,
            ok: result.outcome.ok,
            summary: result.outcome.summary,
            warnings: result.outcome.warnings,
            alreadyDone: result.outcome.alreadyDone,
            terminal: result.outcome.terminal ?? false,
        });

        /**
         * A failed call is a 502, not a 500: the panel did its part and
         * something on the other side said no. The body is the same shape
         * either way, so a client reads `ok` rather than guessing from the
         * status.
         */
        return json(body, result.outcome.ok ? 200 : 502);
    } catch (error) {
        if (
            error instanceof ServiceActionError ||
            error instanceof ProvisioningInputError
        ) {
            return problem(409, "Aktion nicht möglich", error.message);
        }

        throw error;
    }
}
