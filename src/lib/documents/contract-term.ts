/**
 * Contract clock arithmetic, straight from § 8 of the terms:
 *
 *   (1) the Grundlaufzeit runs from Service-Readiness and ends N months after
 *       the END of the month in which Service-Readiness was reached;
 *   (2) unless notice reaches the other side at least one month before that
 *       date, the contract renews for an indefinite period and can then be
 *       terminated at any time with one month's notice.
 *
 * All arithmetic is in UTC because that is how the dates are stored — an
 * <input type="date"> writes midnight UTC through parseDate().
 */

/** Adds calendar months, clamping the day like § 188 BGB: 31.03. + 1 = 30.04. */
function addMonths(date: Date, months: number) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    return new Date(
        Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)),
    );
}

/** Day 0 of the following month is the last day of this one. */
function endOfMonth(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/**
 * The end of the Grundlaufzeit, or null while the clock has not started —
 * without Service-Readiness there is nothing to count from.
 */
export function minimumTermEnd(
    serviceReadyAt: Date | null,
    minimumTermMonths: number,
) {
    if (!serviceReadyAt) {
        return null;
    }

    return endOfMonth(addMonths(endOfMonth(serviceReadyAt), minimumTermMonths));
}

/**
 * The earliest date the contract can be terminated to, for notice received on
 * `noticeReceivedAt`. Inside the Grundlaufzeit that is its end; once the
 * one-month window before it has passed — or while no term is running at all
 * — it is one month from the notice.
 */
export function earliestTerminationDate(
    contract: { serviceReadyAt: Date | null; minimumTermMonths: number },
    noticeReceivedAt: Date,
) {
    const oneMonthOn = addMonths(noticeReceivedAt, 1);
    const termEnd = minimumTermEnd(
        contract.serviceReadyAt,
        contract.minimumTermMonths,
    );

    if (!termEnd) {
        return oneMonthOn;
    }

    // § 8 (2): notice must arrive one month before the term ends, otherwise
    // the contract has already renewed and only the one-month notice applies.
    return noticeReceivedAt <= addMonths(termEnd, -1) ? termEnd : oneMonthOn;
}

/** First and last day of the month `date` falls in — one billing period. */
export function billingPeriod(date: Date) {
    return {
        start: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
        end: endOfMonth(date),
    };
}
