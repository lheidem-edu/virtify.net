import { Label } from "@/components/ui/label";

/** One select, styled like the inputs around it. */
export default function SelectField({
    id,
    name,
    label,
    options,
    defaultValue,
    placeholder,
    required,
    help,
}: {
    id: string;
    name?: string;
    label: string;
    options: { value: string; label: string }[];
    defaultValue?: string;
    /** Shown as a disabled first entry when nothing is selected yet. */
    placeholder?: string;
    required?: boolean;
    help?: string;
}) {
    return (
        <div className="space-y-3">
            <Label htmlFor={id}>{label}</Label>
            <select
                id={id}
                name={name ?? id}
                required={required}
                defaultValue={defaultValue ?? (placeholder ? "" : undefined)}
                className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30"
            >
                {placeholder ? (
                    <option value="" disabled={required}>
                        {placeholder}
                    </option>
                ) : null}
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            {help ? (
                <p className="text-xs text-muted-foreground">{help}</p>
            ) : null}
        </div>
    );
}
