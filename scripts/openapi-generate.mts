/**
 * Writes the specification to public/openapi.json.
 *
 *   npm run openapi:generate
 *
 * The live document at /api/v1/openapi.json is built from the same registry,
 * so this file is a convenience for tooling that wants it on disk — never a
 * source. Regenerate it when an endpoint changes.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSpec } from "@/server/openapi/spec";

const target = path.join(process.cwd(), "public", "openapi.json");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(buildSpec(), null, 4)}\n`, "utf8");

const { paths } = buildSpec();
const count = Object.values(paths ?? {}).reduce(
    (sum, item) => sum + Object.keys(item).length,
    0,
);

console.log(
    `Wrote ${path.relative(process.cwd(), target)} — ${count} endpoints.`,
);
