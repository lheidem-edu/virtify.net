const TONE = {
    neutral: "border-border text-muted-foreground",
    positive: "border-emerald-500/40 text-emerald-400",
    warning: "border-amber-500/40 text-amber-400",
    muted: "border-border text-zinc-600",
} as const;

export default function StatusBadge({
    label,
    tone = "neutral",
}: {
    label: string;
    tone?: keyof typeof TONE;
}) {
    return (
        <span
            className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs ${TONE[tone]}`}
        >
            {label}
        </span>
    );
}
