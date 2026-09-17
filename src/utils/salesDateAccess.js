/**
 * Sales date access: staff without report.view may only see today's sales (Europe/London).
 */

const { can } = require('./dashboardHelpers');
const { getLondonDateKey } = require('./dateKey');

const LONDON_TZ = 'Europe/London';

function startOfDayLondonUTC(year, month, day) {
  const noon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(noon);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const offsetMs = (hour * 60 + minute - 12 * 60) * 60 * 1000;
  return new Date(noon.getTime() - 12 * 60 * 60 * 1000 - offsetMs);
}

function endOfDayLondonUTC(year, month, day) {
  const start = startOfDayLondonUTC(year, month, day);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function getTodayLondonBounds() {
  const todayStr = getLondonDateKey(new Date());
  const [y, m, d] = todayStr.split('-').map(Number);
  return {
    fromUtc: startOfDayLondonUTC(y, m, d),
    toUtc: endOfDayLondonUTC(y, m, d),
    dateKey: todayStr,
  };
}

/** UTC instants for London calendar date keys (YYYY-MM-DD), inclusive end of day. */
function getLondonDateUtcBounds(fromDateKey, toDateKey) {
  const [fy, fm, fd] = String(fromDateKey || '').split('-').map(Number);
  const [ty, tm, td] = String(toDateKey || fromDateKey || '').split('-').map(Number);
  if (!fy || !fm || !fd) {
    const b = getTodayLondonBounds();
    return { fromUtc: b.fromUtc, toUtc: b.toUtc };
  }
  return {
    fromUtc: startOfDayLondonUTC(fy, fm, fd),
    toUtc: endOfDayLondonUTC(ty || fy, tm || fm, td || fd),
  };
}

function canViewHistoricalSales(user) {
  return can(user, 'report.view');
}

/**
 * @param {object} user
 * @param {{ from?: Date|string, to?: Date|string }} opts
 * @returns {{ restricted: boolean, from?: Date, to?: Date, dateKey?: string }}
 */
function applySalesDateRestriction(user, { from, to } = {}) {
  if (canViewHistoricalSales(user)) {
    return { restricted: false, from, to };
  }
  const bounds = getTodayLondonBounds();
  return {
    restricted: true,
    from: bounds.fromUtc,
    to: bounds.toUtc,
    dateKey: bounds.dateKey,
  };
}

function isWithinTodayLondon(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const { fromUtc, toUtc } = getTodayLondonBounds();
  return d >= fromUtc && d <= toUtc;
}

function assertSaleViewableByUser(user, sale) {
  if (canViewHistoricalSales(user)) {
    return { ok: true };
  }
  const saleDate = sale.occurredAt || sale.createdAt;
  if (!isWithinTodayLondon(saleDate)) {
    return {
      ok: false,
      status: 403,
      message: "You can only view today's sales. Historical sales require report access.",
    };
  }
  return { ok: true };
}

module.exports = {
  canViewHistoricalSales,
  getTodayLondonBounds,
  getLondonDateUtcBounds,
  applySalesDateRestriction,
  isWithinTodayLondon,
  assertSaleViewableByUser,
};
