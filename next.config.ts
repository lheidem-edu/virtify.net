import { execSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * The commit the running build was produced from. Shown in the footer so it is
 * always obvious which revision is live. CI variables win over the working
 * tree, since a container build usually has no .git directory.
 */
function resolveCommit(): string {
    const fromEnv =
        process.env.GIT_COMMIT_SHA ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.GITHUB_SHA;

    if (fromEnv) {
        return fromEnv.slice(0, 7);
    }

    try {
        return execSync("git rev-parse --short=7 HEAD", {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "unbekannt";
    }
}

const nextConfig: NextConfig = {
    env: {
        NEXT_PUBLIC_COMMIT: resolveCommit(),
    },
    /**
     * The customer area moved from /account to /client when the portal became
     * the product. Every invoice and offer mail ever sent links to the old
     * path — "Rechnung ansehen" points at /account/invoices/<id>/pdf — and the
     * AGB in force name it too, so the old paths have to keep working for as
     * long as those documents exist. Permanent, because /account is retired
     * and nothing will be served there again.
     */
    async redirects() {
        return [
            {
                source: "/account",
                destination: "/client",
                permanent: true,
            },
            {
                source: "/account/:path*",
                destination: "/client/:path*",
                permanent: true,
            },
        ];
    },
};

export default nextConfig;
