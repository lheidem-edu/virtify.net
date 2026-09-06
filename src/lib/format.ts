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

export const OFFER_STATUS_LABEL = {
    draft: "Entwurf",
    sent: "Versendet",
    accepted: "Angenommen",
    declined: "Abgelehnt",
    expired: "Abgelaufen",
} as const;

export const INVOICE_STATUS_LABEL = {
    draft: "Entwurf",
    issued: "Ausgestellt",
    paid: "Bezahlt",
    cancelled: "Storniert",
} as const;

export const OFFER_STATUS_TONE = {
    draft: "muted",
    sent: "warning",
    accepted: "positive",
    declined: "neutral",
    expired: "neutral",
} as const;

export const INVOICE_STATUS_TONE = {
    draft: "muted",
    issued: "warning",
    paid: "positive",
    cancelled: "neutral",
} as const;

export const CONTRACT_STATUS_TONE = {
    provisioning: "warning",
    active: "positive",
    terminated: "neutral",
    ended: "muted",
} as const;
