export default function LegalList({
    items,
    variant = "dash",
}: {
    items: React.ReactNode[];
    /** "paren" renders "(1)" like the paper contracts, "dash" an em dash. */
    variant?: "dash" | "paren";
}) {
    const className = `legal-list legal-list--${variant} space-y-3`;

    const children = items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static legal copy
        <li key={index}>{item}</li>
    ));

    return variant === "paren" ? (
        <ol className={className}>{children}</ol>
    ) : (
        <ul className={className}>{children}</ul>
    );
}
