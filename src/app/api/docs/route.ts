import { ApiReference } from "@scalar/nextjs-api-reference";

/**
 * Scalar renders the live specification, so the reference cannot describe a
 * version of the API that is not the one running.
 */
export const GET = ApiReference({
    url: "/api/v1/openapi.json",
    pageTitle: "virtify.net API",
});
