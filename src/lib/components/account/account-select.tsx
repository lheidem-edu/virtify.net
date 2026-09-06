import { Label } from "@/components/ui/label";

const selectClass =
    "w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export default function AccountSelect({
    accounts,
    id = "userId",
}: {
    accounts: { id: string; name: string | null; email: string }[];
    id?: string;
}) {
    if (accounts.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                Es gibt noch keine Konten.
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <Label htmlFor={id}>Konto</Label>
            <select
                id={id}
                name="userId"
                required
                defaultValue=""
                className={selectClass}
            >
                <option value="" disabled>
                    Bitte wählen
                </option>
                {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                        {account.email}
                        {account.name ? ` — ${account.name}` : ""}
                    </option>
                ))}
            </select>
        </div>
    );
}
