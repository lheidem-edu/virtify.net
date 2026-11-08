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
    unpaid: "Offen",
    partial: "Teilweise bezahlt",
    paid: "Bezahlt",
    cancelled: "Korrigiert",
} as const;

export const OFFER_STATUS_TONE = {
    draft: "muted",
    sent: "warning",
    accepted: "positive",
    declined: "neutral",
    expired: "neutral",
    withdrawn: "neutral",
} as const;

/**
 * Overdue is not a status: the invoice is still "issued", it has simply passed
 * its due date. Deriving it on read keeps it true without a job that has to
 * run every night to make it true.
 */
export function isOverdue(invoice: {
    status: string;
    dueAt: Date | null;
    paidAt: Date | null;
}) {
    return (
        (invoice.status === "unpaid" || invoice.status === "partial") &&
        !invoice.paidAt &&
        invoice.dueAt !== null &&
        invoice.dueAt.getTime() < Date.now()
    );
}

/** Whole days a due date has been in the past; 0 when it has not. */
export function daysOverdue(dueAt: Date | null) {
    if (!dueAt) {
        return 0;
    }

    const days = Math.floor((Date.now() - dueAt.getTime()) / 86_400_000);
    return days > 0 ? days : 0;
}

export const INVOICE_STATUS_TONE = {
    draft: "muted",
    unpaid: "warning",
    // Warning, like "offen": money is still owed, and the colour that says
    // "nothing to do here" would be a lie.
    partial: "warning",
    paid: "positive",
    cancelled: "neutral",
} as const;

export const PAYMENT_PROVIDER_LABEL = {
    stripe: "Kreditkarte",
    paypal: "PayPal",
    banktransfer: "Überweisung",
    credit: "Guthaben",
} as const;

export const PAYMENT_STATUS_LABEL = {
    pending: "Begonnen",
    processing: "Unterwegs",
    succeeded: "Eingegangen",
    failed: "Fehlgeschlagen",
    refunded: "Erstattet",
} as const;

export const PAYMENT_STATUS_TONE = {
    pending: "muted",
    processing: "warning",
    succeeded: "positive",
    failed: "neutral",
    refunded: "neutral",
} as const;

export const DISPUTE_STATUS_LABEL = {
    open: "Offen",
    under_review: "In Prüfung",
    won: "Gewonnen",
    lost: "Verloren",
    withdrawn: "Zurückgezogen",
} as const;

export const DISPUTE_STATUS_TONE = {
    open: "warning",
    under_review: "warning",
    won: "positive",
    lost: "neutral",
    withdrawn: "muted",
} as const;

export const CREDIT_NOTE_KIND_LABEL = {
    full: "Vollständig",
    partial: "Teilweise",
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
    // A correction line carries a negative quantity; -1 is still singular.
    const unit =
        Math.abs(quantity) === 1
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

export const ORDER_STATUS_LABEL = {
    pending: "Offen",
    active: "Angenommen",
    cancelled: "Storniert",
    fraud: "Betrug",
} as const;

export const ORDER_STATUS_TONE = {
    pending: "warning",
    active: "positive",
    cancelled: "muted",
    fraud: "muted",
} as const;

export const SUBSCRIPTION_STATUS_LABEL = {
    trialing: "Testphase",
    active: "Aktiv",
    past_due: "Überfällig",
    paused: "Pausiert",
    cancelled: "Gekündigt",
    ended: "Beendet",
} as const;

export const SUBSCRIPTION_STATUS_TONE = {
    trialing: "warning",
    active: "positive",
    past_due: "warning",
    paused: "neutral",
    cancelled: "muted",
    ended: "muted",
} as const;

export const SERVICE_STATUS_LABEL = {
    pending: "Wartet",
    provisioning: "In Einrichtung",
    active: "Aktiv",
    suspended: "Gesperrt",
    terminated: "Beendet",
} as const;

export const SERVICE_STATUS_TONE = {
    pending: "warning",
    provisioning: "warning",
    active: "positive",
    suspended: "warning",
    terminated: "muted",
} as const;

export const PAYMENT_OPTION_LABEL = {
    bank_transfer: "Überweisung",
    stripe: "Karte (Stripe)",
    paypal: "PayPal",
} as const;

const dateTime = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
});

/** Rule 9: stored in UTC, shown in Europe/Berlin. */
export function formatDateTime(value: Date | null | undefined) {
    return value ? dateTime.format(value) : "—";
}

export const TICKET_STATUS_LABEL = {
    open: "Offen",
    waiting: "Wartet auf Kunden",
    on_hold: "Zurückgestellt",
    closed: "Geschlossen",
} as const;

export const TICKET_STATUS_TONE = {
    open: "warning",
    waiting: "neutral",
    on_hold: "muted",
    closed: "muted",
} as const;

export const TICKET_PRIORITY_LABEL = {
    low: "Niedrig",
    normal: "Normal",
    high: "Hoch",
    urgent: "Dringend",
} as const;

export const TICKET_PRIORITY_TONE = {
    low: "muted",
    normal: "neutral",
    high: "warning",
    urgent: "warning",
} as const;

/** Byte sizes for an attachment list. Decimal, which is what a mail client shows. */
export function formatBytes(bytes: number) {
    if (bytes < 1000) {
        return `${bytes} B`;
    }

    const units = ["kB", "MB", "GB"];
    let value = bytes / 1000;
    let unit = 0;

    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }

    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
