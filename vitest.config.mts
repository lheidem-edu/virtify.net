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
     */
    ssr: {
        resolve: {
            conditions: ["react-server", "node", "import", "default"],
            externalConditions: ["react-server", "node", "import", "default"],
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        globals: false,
    },
});
