const euro = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
});

const date = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
});

export function formatPrice(cents: number) {
    return euro.format(cents / 100);
}

export function formatDate(value: Date | null | undefined) {
    return value ? date.format(value) : "—";
}

export const CONTRACT_STATUS_LABEL = {
    provisioning: "In Bereitstellung",
    active: "Aktiv",
    terminated: "Gekündigt",
    ended: "Beendet",
} as const;
