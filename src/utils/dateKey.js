/**
 * Get London date key (YYYY-MM-DD) from a UTC Date for metrics aggregation.
 * Used by LocationDailyMetric and TenantDailyMetric.
 */
function getLondonDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
}

/**
 * Get current month range in London (YYYY-MM-DD) for usage queries (e.g. repairs this month).
 * @returns {{ start: string, end: string }} start = first day, end = last day of month
 */
function getLondonMonthRange() {
    const now = new Date();
    const key = getLondonDateKey(now);
    const [y, m] = key.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
        start: `${y}-${String(m).padStart(2, '0')}-01`,
        end: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    };
}

/**
 * UTC instant of London midnight that starts the London calendar day containing `date`.
 * Used for per-day limits that reset at local midnight.
 * London is UTC+0 or UTC+1 and DST switches at 01:00 UTC (never around midnight),
 * so the offset observed at UTC midnight of that date is the offset at London midnight.
 */
function getLondonDayStart(date) {
    const d = date instanceof Date ? date : new Date(date);
    const [y, m, day] = getLondonDateKey(d).split('-').map(Number);
    const utcMidnight = Date.UTC(y, m - 1, day);
    const londonHourAtUtcMidnight = Number(
        new Date(utcMidnight).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' })
    );
    return new Date(utcMidnight - londonHourAtUtcMidnight * 60 * 60 * 1000);
}

module.exports = { getLondonDateKey, getLondonMonthRange, getLondonDayStart };
