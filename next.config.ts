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
    /**
     * Produces .next/standalone — the server plus only the dependencies it
     * actually reaches — so the container image carries no devDependencies and
     * no source tree.
     */
    output: "standalone",

    /**
     * Two modules read files from the working directory at runtime rather than
     * importing them, so the tracer cannot see them and would leave them out
     * of the standalone build: the invoice PDF's fonts, and the wording a
     * legal document starts from. Without the fonts an invoice silently falls
     * back to Helvetica; without the defaults /terms throws.
     */
    outputFileTracingIncludes: {
        "/**": [
            "./src/server/documents/fonts/**",
            "./src/server/legal/defaults/**",
        ],
    },

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
