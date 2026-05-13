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

module.exports = { getLondonDateKey, getLondonMonthRange };
