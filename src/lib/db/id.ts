/**
 * Kept as the import path the schema and the existing queries already use.
 * The generator itself lives in `src/lib/ulid.ts`, so there is one monotonic
 * source and one list of prefixes rather than two that can drift apart.
 */
export { createId, ID_PREFIX, type IdPrefix } from "@/lib/ulid";
