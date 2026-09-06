#!/usr/bin/env node
/**
 * Development database. Runs PostgreSQL in a single container with a named
 * volume, so data survives restarts. Production runs its own container that
 * Dokploy manages — nothing here is used there.
 *
 *   npm run db:up      start (and create on first run)
 *   npm run db:down    stop, keeping the volume
 *   npm run db:reset   stop and drop the volume
 *   npm run db:logs    follow the container log
 */
import { execFileSync, spawnSync } from "node:child_process";

const NAME = "virtify-postgres";
const VOLUME = "virtify-postgres-data";
const IMAGE = "postgres:18-alpine";
const PORT = 5433; // not 5432, so a local Postgres install is left alone
const USER = "virtify";
const PASSWORD = "virtify";
const DATABASE = "virtify";

const URL = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;

function docker(args, { capture = false } = {}) {
    if (capture) {
        return execFileSync("docker", args, { encoding: "utf8" }).trim();
    }
    const result = spawnSync("docker", args, { stdio: "inherit" });
    return result.status ?? 1;
}

function state() {
    try {
        return docker(["inspect", "-f", "{{.State.Status}}", NAME], {
            capture: true,
        });
    } catch {
        return null;
    }
}

function up() {
    const current = state();

    if (current === "running") {
        console.log(`already running on port ${PORT}`);
    } else if (current) {
        docker(["start", NAME]);
    } else {
        console.log(`creating ${NAME} from ${IMAGE} ...`);
        const code = docker([
            "run",
            "--detach",
            "--name",
            NAME,
            "--volume",
            `${VOLUME}:/var/lib/postgresql`,
            "--publish",
            `127.0.0.1:${PORT}:5432`,
            "--env",
            `POSTGRES_USER=${USER}`,
            "--env",
            `POSTGRES_PASSWORD=${PASSWORD}`,
            "--env",
            `POSTGRES_DB=${DATABASE}`,
            "--restart",
            "unless-stopped",
            IMAGE,
        ]);
        if (code !== 0) {
            process.exit(code);
        }
    }

    // Wait until the server accepts connections, so `db:up && db:migrate`
    // does not race the container's startup.
    for (let attempt = 0; attempt < 60; attempt++) {
        const ready = spawnSync(
            "docker",
            ["exec", NAME, "pg_isready", "-U", USER, "-d", DATABASE],
            { stdio: "ignore" },
        );
        if (ready.status === 0) {
            console.log(`\nready\n\n  DATABASE_URL=${URL}\n`);
            return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }

    console.error("database did not become ready in time");
    process.exit(1);
}

const commands = {
    up,
    down: () => docker(["stop", NAME]),
    logs: () => docker(["logs", "--follow", NAME]),
    reset: () => {
        spawnSync("docker", ["rm", "--force", NAME], { stdio: "ignore" });
        spawnSync("docker", ["volume", "rm", VOLUME], { stdio: "ignore" });
        console.log("container and volume removed");
    },
};

const command = commands[process.argv[2]];

if (!command) {
    console.error(
        `usage: node scripts/db.mjs <${Object.keys(commands).join("|")}>`,
    );
    process.exit(1);
}

command();
