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
    withdrawn: "Zurückgezogen",
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
    withdrawn: "neutral",
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

/** UN/ECE Recommendation 20 codes as they should print on a document. */
const UNIT_LABEL: Record<string, string> = {
    C62: "Stk.",
    MON: "Monat",
    ANN: "Jahr",
    HUR: "Std.",
    DAY: "Tag",
};

const UNIT_LABEL_PLURAL: Record<string, string> = {
    C62: "Stk.",
    MON: "Monate",
    ANN: "Jahre",
    HUR: "Std.",
    DAY: "Tage",
};

/**
 * Quantity and unit as one phrase — "12 Monate", "1 Monat", "2,5 Std." Whole
 * numbers print without decimals; a line for one month should not read "1,00".
 */
export function formatQuantity(quantity: number, unitCode: string) {
    const amount = quantity.toLocaleString("de-DE", {
        maximumFractionDigits: 2,
    });
    const unit =
        quantity === 1
            ? UNIT_LABEL[unitCode]
            : (UNIT_LABEL_PLURAL[unitCode] ?? UNIT_LABEL[unitCode]);

    return unit ? `${amount} ${unit}` : `${amount} ${unitCode}`;
}

/**
 * A date range in the German short form: the year is only repeated when the
 * two dates fall in different years, which keeps it inside a narrow column.
 */
export function formatDateRange(
    start: Date | null | undefined,
    end: Date | null | undefined,
) {
    if (!start) {
        return "—";
    }

    if (!end) {
        return formatDate(start);
    }

    const sameYear = start.getFullYear() === end.getFullYear();
    const from = sameYear
        ? new Intl.DateTimeFormat("de-DE", {
              day: "2-digit",
              month: "2-digit",
              timeZone: "Europe/Berlin",
          }).format(start)
        : formatDate(start);

    return `${from} – ${formatDate(end)}`;
}
