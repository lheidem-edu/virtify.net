/**
 * The success/error banner every form in the account area renders. Page forms
 * get the boxed variant, forms sitting inside a table row or a dialog get the
 * bare one — the box would fight with the surface it sits on.
 */
export default function FormStatus({
    tone,
    message,
    variant = "page",
}: {
    tone: "success" | "error";
    message?: string;
    variant?: "page" | "inline";
}) {
    if (!message) {
        return null;
    }

    if (variant === "inline") {
        return (
            <p
                className={`max-w-xs text-xs leading-5 ${
                    tone === "error" ? "text-destructive" : "text-zinc-300"
                }`}
            >
                {message}
            </p>
        );
    }

    return (
        <p
            className={
                tone === "error"
                    ? "rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
                    : "rounded-lg border p-4 text-sm text-zinc-300"
            }
        >
            {message}
        </p>
    );
}
