"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export default function SignOutButton() {
    const router = useRouter();
    const [pending, setPending] = useState(false);

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={async () => {
                setPending(true);
                await authClient.signOut();
                router.push("/customer/login");
                router.refresh();
            }}
        >
            {pending ? "…" : "Abmelden"}
        </Button>
    );
}
