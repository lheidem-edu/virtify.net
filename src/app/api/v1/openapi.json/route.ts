import { NextResponse } from "next/server";
import { buildSpec } from "@/server/openapi/spec";

export const dynamic = "force-dynamic";

/**
 * The live specification. `npm run openapi:generate` writes the same document
 * to public/openapi.json for anything that wants it as a file, but this is the
 * copy that can never be stale.
 */
export function GET() {
    return NextResponse.json(buildSpec(), {
        headers: { "cache-control": "no-store" },
    });
}
