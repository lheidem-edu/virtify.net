import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    /**
     * The same condition `next dev` uses for server code. Without it the
     * `server-only` package throws on import, and every module that guards
     * itself with it would be untestable. Vitest resolves test modules through
     * Vite's SSR pipeline, so the condition belongs here and not under
     * `resolve`.
     *
     * `require` rather than `import`, and deliberately so: these conditions
     * reach Node's own resolver, where they apply to `require()` as well. With
     * `import` among them, a CommonJS dependency's `require("x")` picks x's
     * ESM build — and since Node 22 that returns a module namespace, not the
     * export. node-postgres then fails with "Class extends value [object
     * Module]" before it opens a single connection.
     */
    ssr: {
        resolve: {
            conditions: ["react-server", "node", "require", "default"],
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        globals: false,
        setupFiles: ["tests/setup.ts"],
        // The integration tests create, migrate and drop a database of their
        // own; that is slower than the unit suite and deserves more rope.
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
