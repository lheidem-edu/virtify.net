"use client";

import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The browser half of the employees' authentication. It talks to
 * /api/staff-auth, so a customer session in the same browser is untouched by
 * anything that happens here.
 */
export const staffAuthClient = createAuthClient({
    basePath: "/api/staff-auth",
    // No onTwoFactorRedirect: the sign-in page asks for the code itself.
    // Navigating away here would land on a page that requires the session the
    // code is about to establish, and bounce straight back to the login.
    plugins: [twoFactorClient()],
});
