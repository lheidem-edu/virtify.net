import { NextResponse } from "next/server";
import type { z } from "zod";
import type { HealthSchema } from "@/server/openapi/paths/health";

export const dynamic = "force-dynamic";

/**
 * Deliberately touches nothing: no session, no database, no settings. A health
 * check that depends on the database reports the database, not the process,
 * and an orchestrator would then restart a healthy container because Postgres
 * was busy.
 */
export function GET() {
    const body: z.infer<typeof HealthSchema> = {
        status: "ok",
        time: new Date().toISOString(),
        commit: process.env.NEXT_PUBLIC_COMMIT ?? "unbekannt",
    };

    return NextResponse.json(body, {
        headers: { "cache-control": "no-store" },
    });
}
