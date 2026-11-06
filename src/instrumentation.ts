/**
 * Runs once per server start, before the first request is served. Validating
 * the environment here means a container with a missing secret dies on boot
 * with a readable message instead of serving errors.
 */
export async function register() {
    const { assertEnv } = await import("@/lib/env");

    assertEnv();
}
