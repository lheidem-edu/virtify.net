"use client";

import {
    adminClient,
    inferAdditionalFields,
    twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { auth } from "@/lib/auth";

export const authClient = createAuthClient({
    plugins: [
        inferAdditionalFields<typeof auth>(),
        twoFactorClient(),
        adminClient(),
    ],
});

export const { signIn, signUp, signOut, useSession } = authClient;
