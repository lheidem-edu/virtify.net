import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function spec() {
    const { buildSpec } = await import("@/server/openapi/spec");

    return buildSpec();
}

type Operation = {
    summary?: string;
    description?: string;
    tags?: string[];
    responses?: Record<string, unknown>;
};

async function operations(): Promise<[string, string, Operation][]> {
    const { paths } = await spec();

    return Object.entries(paths ?? {}).flatMap(([path, item]) =>
        Object.entries(item as Record<string, Operation>).map(
            ([method, operation]) =>
                [path, method, operation] as [string, string, Operation],
        ),
    );
}

describe("the specification", () => {
    /**
     * Two registrations of one component name is not an error anywhere: the
     * generator keeps the first and says nothing. Phase 8 registered
     * `Service` for the service detail while `orders.ts` already had one for
     * the small order-time shape, and the detail endpoint was published as
     * somebody else's five-field object — with no failing test, because
     * every other assertion here is about *paths*.
     *
     * The registry itself cannot be asked for its names, so this reaches
     * them the way a reader would: every `$ref` the document resolves has to
     * find a component, and every component has to be the one its own
     * module registered.
     */
    it("registers each component name exactly once", async () => {
        const modules = await Promise.all(
            fs
                .readdirSync(
                    path.join(process.cwd(), "src/server/openapi/paths"),
                )
                .filter((file) => file.endsWith(".ts") && file !== "index.ts")
                .map(async (file) => ({
                    file,
                    source: fs.readFileSync(
                        path.join(
                            process.cwd(),
                            "src/server/openapi/paths",
                            file,
                        ),
                        "utf8",
                    ),
                })),
        );

        const seen = new Map<string, string>();
        const clashes: string[] = [];

        for (const { file, source } of modules) {
            for (const match of source.matchAll(
                /registry\.register\(\s*\n?\s*"([A-Za-z0-9_]+)"/g,
            )) {
                const name = match[1];
                const first = seen.get(name);

                if (first) {
                    clashes.push(`${name}: ${first} and ${file}`);
                } else {
                    seen.set(name, file);
                }
            }
        }

        expect(clashes).toEqual([]);
        // A tripwire on the tripwire: if the regex stops matching, the test
        // passes vacuously.
        expect(seen.size).toBeGreaterThan(20);
    });

    it("is OpenAPI 3.1 and points at whatever origin served it", async () => {
        const document = await spec();

        expect(document.openapi).toBe("3.1.0");
        expect(document.info.title).toBe("virtify.net API");
        // Relative: a hard-coded origin would be wrong everywhere but one
        // instance, and it would make the document depend on the environment.
        expect(document.servers?.[0]?.url).toBe("/");
    });

    it("is deterministic, so the checked-in copy cannot drift", async () => {
        // public/openapi.json is written by `npm run openapi:generate`. If
        // this fails, an endpoint changed and nobody regenerated it.
        const onDisk = JSON.parse(
            fs.readFileSync(
                path.join(process.cwd(), "public", "openapi.json"),
                "utf8",
            ),
        );

        expect(onDisk).toEqual(await spec());
    });

    it("explains authentication, pagination, errors and amounts up front", async () => {
        const { description } = (await spec()).info;

        for (const topic of [
            "Authentifizierung",
            "Seitenweise Abfrage",
            "Fehler",
            "Beträge",
        ]) {
            expect(description).toContain(topic);
        }
    });

    it("registers the API-key scheme", async () => {
        const schemes = (await spec()).components?.securitySchemes ?? {};

        expect(schemes).toHaveProperty("ApiKey");
        expect(schemes.ApiKey).toMatchObject({
            type: "http",
            scheme: "bearer",
        });
    });

    it("has at least one endpoint, so the pipeline is proven", async () => {
        expect((await operations()).length).toBeGreaterThan(0);
    });
});

describe("every endpoint is documented", () => {
    // CLAUDE.md rule 11: an endpoint without docs is not done. This is the
    // check that makes that a rule rather than a hope.
    it("carries a summary, a description and a tag", async () => {
        for (const [path, method, operation] of await operations()) {
            const where = `${method.toUpperCase()} ${path}`;

            expect(operation.summary, `${where} has no summary`).toBeTruthy();
            expect(
                operation.description,
                `${where} has no description`,
            ).toBeTruthy();
            expect(operation.tags?.length, `${where} has no tag`).toBeTruthy();
        }
    });

    it("documents a success and the error shape", async () => {
        for (const [path, method, operation] of await operations()) {
            const where = `${method.toUpperCase()} ${path}`;
            const codes = Object.keys(operation.responses ?? {});

            expect(
                codes.some((code) => code.startsWith("2")),
                `${where} documents no success response`,
            ).toBe(true);
            expect(codes, `${where} documents no 401`).toContain("401");
        }
    });

    it("gives every field of every schema a description", async () => {
        const schemas = (await spec()).components?.schemas ?? {};

        /**
         * A field whose type is another registered schema comes out as
         * `allOf: [{ $ref }, { description }]` — OpenAPI's way of saying
         * "that shape, described here", because a bare `$ref` may carry no
         * siblings. That counts as described; a bare `$ref` with nothing
         * beside it does not, which is the case this check is for.
         */
        const described = (value: {
            description?: string;
            allOf?: { description?: string }[];
        }) =>
            Boolean(
                value.description ||
                    value.allOf?.some((entry) => entry?.description),
            );

        for (const [name, schema] of Object.entries(schemas)) {
            const properties =
                (
                    schema as {
                        properties?: Record<
                            string,
                            {
                                description?: string;
                                allOf?: { description?: string }[];
                            }
                        >;
                    }
                ).properties ?? {};

            for (const [field, value] of Object.entries(properties)) {
                expect(
                    described(value),
                    `${name}.${field} has no description`,
                ).toBe(true);
            }
        }
    });
});
