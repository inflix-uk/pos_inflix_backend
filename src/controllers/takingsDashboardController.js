/**
 * Takings Dashboard: unified API for takings by payment method + P&L summary.
 * GET /api/reports/takings-dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId=all|<id>
 * Default period: today (Europe/London). Respects tenantId and location scope.
 */

const mongoose = require('mongoose');
const { getLondonDateKey } = require('../utils/dateKey');
const { canViewHistoricalSales, getTodayLondonBounds, getLondonDateUtcBounds } = require('../utils/salesDateAccess');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const Location = require('../models/Location');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const Expense = require('../models/Expense');
const asyncHandler = require('../middleware/asyncHandler');
const redis = require('../lib/redis');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const AGG_MAX_TIME_MS = 25000;

function agg(pipeline, model) {
  return model.aggregate(pipeline).option({ maxTimeMS: AGG_MAX_TIME_MS });
}

/** Map ledger method groups into cash/card/bank/credit (transfer → bank; refund → cash). */
function mergeLedgerRowsToBuckets(rows) {
  const b = {
    cash: { in: 0, out: 0 },
    card: { in: 0, out: 0 },
    bank: { in: 0, out: 0 },
    credit: { in: 0, out: 0 },
  };
  for (const r of rows || []) {
    let m = r._id;
    if (m === '' || m == null) m = 'cash';
    m = String(m).toLowerCase();
    let key = m;
    if (m === 'transfer') key = 'bank';
    else if (m === 'refund') key = 'cash';
    else if (!b[key]) key = 'bank';
    b[key].in += Number(r.in) || 0;
    b[key].out += Number(r.out) || 0;
  }
  return b;
}

function sumBucketOut(b) {
  return (b.cash?.out || 0) + (b.card?.out || 0) + (b.bank?.out || 0) + (b.credit?.out || 0);
}

/** When ledger has no refund OUT rows, split refundsGross across methods by sale-mix (better than all cash). */
function applyProportionalRefundOut(buckets, refundsGross) {
  const g = round2(Number(refundsGross) || 0);
  if (g < 0.005) return;
  const cashIn = buckets.cash.in || 0;
  const cardIn = buckets.card.in || 0;
  const bankIn = buckets.bank.in || 0;
  const creditIn = buckets.credit.in || 0;
  const t = cashIn + cardIn + bankIn + creditIn;
  if (t < 0.005) {
    buckets.cash.out = round2((buckets.cash.out || 0) + g);
    return;
  }
  let allocated = 0;
  const parts = [
    ['cash', cashIn],
    ['card', cardIn],
    ['bank', bankIn],
    ['credit', creditIn],
  ];
  for (let i = 0; i < parts.length; i += 1) {
    const [k, w] = parts[i];
    const share = i === parts.length - 1 ? round2(g - allocated) : round2((g * w) / t);
    allocated = round2(allocated + share);
    buckets[k].out = round2((buckets[k].out || 0) + share);
  }
}

/** London dateKey from Sale (occurredAt or createdAt) for aggregation */
const saleLondonDateKey = {
  $dateToString: {
    date: { $ifNull: ['$occurredAt', '$createdAt'] },
    format: '%Y-%m-%d',
    timezone: 'Europe/London'
  }
};

/** London dateKey from SalesReturn */
const returnLondonDateKey = {
  $dateToString: {
    date: { $ifNull: ['$occurredAt', { $ifNull: ['$date', '$createdAt'] }] },
    format: '%Y-%m-%d',
    timezone: 'Europe/London'
  }
};

/** Match sale/return activity between UTC instants (shift Z-Read). */
function occurredBetweenUtc(fromUtc, toUtc) {
  return saleEventTimeBetweenUtc(fromUtc, toUtc);
}

function voidedBetweenUtc(fromUtc, toUtc) {
  return voidEventTimeBetweenUtc(fromUtc, toUtc);
}

function returnOccurredBetweenUtc(fromUtc, toUtc) {
  return {
    $or: [
      { occurredAt: { $gte: fromUtc, $lte: toUtc } },
      { occurredAt: null, date: { $gte: fromUtc, $lte: toUtc } },
      { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { date: null }, { createdAt: { $gte: fromUtc, $lte: toUtc } }] },
    ],
  };
}

/** Index-friendly sale activity window (occurredAt when set, else createdAt). */
function saleEventTimeBetweenUtc(fromUtc, toUtc) {
  return {
    $or: [
      { occurredAt: { $gte: fromUtc, $lte: toUtc } },
      { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { createdAt: { $gte: fromUtc, $lte: toUtc } }] },
    ],
  };
}

function voidEventTimeBetweenUtc(fromUtc, toUtc) {
  return {
    $or: [
      { voidedAtUtc: { $gte: fromUtc, $lte: toUtc } },
      { $and: [{ $or: [{ voidedAtUtc: null }, { voidedAtUtc: { $exists: false } }] }, { createdAt: { $gte: fromUtc, $lte: toUtc } }] },
    ],
  };
}

/** Combine location scope $or with a time constraint without clobbering either. */
function applyTimeConstraint(match, timeConstraint) {
  if (!timeConstraint) return;
  const locationOr = match.$or;
  if (!locationOr) {
    Object.assign(match, timeConstraint);
    return;
  }
  delete match.$or;
  match.$and = [{ $or: locationOr }, timeConstraint];
}

/**
 * GET /api/reports/takings-dashboard
 * Query: from, to (YYYY-MM-DD; default today London), locationId (all | id)
 * Optional: fromUtc, toUtc (ISO) — shift window; skips daily-metrics rollup and cache.
 */
exports.getTakingsDashboard = asyncHandler(async (req, res) => {
  const fromParam = (req.query.from || '').trim();
  const toParam = (req.query.to || '').trim();
  const fromUtcParam = (req.query.fromUtc || '').trim();
  const toUtcParam = (req.query.toUtc || '').trim();
  const locationIdParam = (req.query.locationId || 'all').trim().toLowerCase();
  const lite = req.query.lite === '1' || req.query.lite === 'true';
  const tid = getTenantIdFromReq(req);
  const userScope = getUserLocationScope(req.user);

  const todayLondon = getLondonDateKey(new Date());
  let from = fromParam || todayLondon;
  let to = toParam || todayLondon;

  let useUtcRange = false;
  let fromUtc = null;
  let toUtc = null;
  if (fromUtcParam && toUtcParam) {
    fromUtc = new Date(fromUtcParam);
    toUtc = new Date(toUtcParam);
    if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid fromUtc or toUtc' });
    }
    if (toUtc < fromUtc) {
      return res.status(400).json({ success: false, message: 'toUtc must be after fromUtc' });
    }
    useUtcRange = true;
    from = getLondonDateKey(fromUtc);
    to = getLondonDateKey(toUtc);
  }

  if (!canViewHistoricalSales(req.user)) {
    from = todayLondon;
    to = todayLondon;
    if (useUtcRange) {
      const bounds = getTodayLondonBounds();
      fromUtc = bounds.fromUtc;
      toUtc = bounds.toUtc;
    }
  }

  const scopeKey = (userScope && userScope.length) ? userScope.sort().join(',') : 'all';
  const cacheKeySuffix = useUtcRange
    ? `takingsdash:shift:v3:${tid}:${fromUtc.toISOString()}:${toUtc.toISOString()}:${locationIdParam}:${scopeKey}${lite ? ':lite' : ''}`
    : `takingsdash:v6:${tid}:${from}:${to}:${locationIdParam}:${scopeKey}${lite ? ':lite' : ''}`;
  if (!useUtcRange) {
    const cached = await redis.getDashboardCache(cacheKeySuffix);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }
  }

  const dayUtcBounds = !useUtcRange ? getLondonDateUtcBounds(from, to) : null;
  const rangeFromUtc = useUtcRange ? fromUtc : dayUtcBounds.fromUtc;
  const rangeToUtc = useUtcRange ? toUtc : dayUtcBounds.toUtc;
  const useIndexedTimeRange = !!(rangeFromUtc && rangeToUtc);

  const locationMatch = { tenantId: tid };
  if (locationIdParam !== 'all' && locationIdParam) {
    if (userScope && userScope.length > 0 && !userScope.some((id) => id === locationIdParam)) {
      return res.status(403).json({ success: false, message: 'Not allowed to view this location' });
    }
    locationMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  } else if (userScope && userScope.length > 0) {
    locationMatch.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const saleMatch = { tenantId: tid, status: { $ne: 'voided' } };
  if (!useIndexedTimeRange) saleMatch.londonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) saleMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) saleMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) applyTimeConstraint(saleMatch, occurredBetweenUtc(fromUtc, toUtc));
  else if (useIndexedTimeRange) applyTimeConstraint(saleMatch, saleEventTimeBetweenUtc(rangeFromUtc, rangeToUtc));

  const voidMatch = { tenantId: tid, status: 'voided' };
  if (!useIndexedTimeRange) voidMatch.voidLondonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) voidMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) voidMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) applyTimeConstraint(voidMatch, voidedBetweenUtc(fromUtc, toUtc));
  else if (useIndexedTimeRange) applyTimeConstraint(voidMatch, voidEventTimeBetweenUtc(rangeFromUtc, rangeToUtc));

  const returnMatch = { tenantId: tid };
  if (!useIndexedTimeRange) returnMatch.returnLondonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) returnMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) returnMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) applyTimeConstraint(returnMatch, returnOccurredBetweenUtc(fromUtc, toUtc));
  else if (useIndexedTimeRange) applyTimeConstraint(returnMatch, returnOccurredBetweenUtc(rangeFromUtc, rangeToUtc));

  const ledgerDateMatch = { tenantId: tid };
  if (!useIndexedTimeRange) ledgerDateMatch.ledgerLondonDateKey = { $gte: from, $lte: to };
  else ledgerDateMatch.occurredAtUtc = { $gte: rangeFromUtc, $lte: rangeToUtc };
  if (locationIdParam !== 'all' && locationIdParam) ledgerDateMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) ledgerDateMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];

  const fastTimeMatch = useUtcRange || useIndexedTimeRange;
  const expenseUtcRange = fastTimeMatch
    ? { $gte: rangeFromUtc, $lte: rangeToUtc }
    : { $gte: new Date(from + 'T00:00:00.000Z'), $lte: new Date(to + 'T23:59:59.999Z') };

  // Expenses follow the same location rule as sales: one shop shows only that shop's expenses,
  // while expenses with no location are company-wide overhead and surface under "All locations".
  const expenseMatch = {
    tenantId: tid,
    status: { $in: ['Approved', 'Paid'] },
    occurredAtUtc: expenseUtcRange,
  };
  if (locationIdParam !== 'all' && locationIdParam) {
    expenseMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  } else if (userScope && userScope.length > 0) {
    expenseMatch.$or = [
      { locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } },
      { locationId: null },
    ];
  }

  // Payment IN from sales created in the selected period only — never PaymentLedgerEntry dates,
  // which also carry collections against older balances.
  const salePaymentPipeline = (fastTimeMatch
    ? [{ $match: saleMatch }]
    : [{ $addFields: { londonDateKey: saleLondonDateKey } }, { $match: saleMatch }]
  ).concat([
    {
      $project: {
        isWholesale: { $eq: ['$type', 'wholesale'] },
        payCash: { $ifNull: ['$payments.cash', 0] },
        payCard: { $ifNull: ['$payments.card', 0] },
        payBank: { $ifNull: ['$payments.bank', 0] },
        total: { $ifNull: ['$total', 0] },
        // A wholesale invoice is only worth total - discount. Cash/card/bank on the sale record
        // what was handed over at checkout, which may also clear the customer's previous balance
        // (computeWholesaleTotalOwing = previousBalance + net), so it can exceed the invoice.
        netDue: {
          $max: [0, { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$discount', 0] }] }],
        },
        pm: { $toLower: { $ifNull: ['$paymentMethod', 'cash'] } },
      },
    },
    {
      $addFields: { paidNow: { $add: ['$payCash', '$payCard', '$payBank'] } },
    },
    {
      $addFields: {
        // Money taken at checkout that belongs to this invoice; the rest settles an older balance.
        applied: { $min: ['$paidNow', '$netDue'] },
        // Never divide by zero — paidNow of 0 gives applied 0, so the factor is 0 either way.
        safePaid: { $cond: [{ $gt: ['$paidNow', 0] }, '$paidNow', 1] },
      },
    },
    {
      $addFields: { paidFactor: { $divide: ['$applied', '$safePaid'] } },
    },
    {
      $project: {
        cashIn: {
          $cond: [
            '$isWholesale',
            { $multiply: ['$payCash', '$paidFactor'] },
            { $cond: [{ $eq: ['$pm', 'cash'] }, '$total', 0] },
          ],
        },
        cardIn: {
          $cond: [
            '$isWholesale',
            { $multiply: ['$payCard', '$paidFactor'] },
            { $cond: [{ $eq: ['$pm', 'card'] }, '$total', 0] },
          ],
        },
        bankIn: {
          $cond: [
            '$isWholesale',
            { $multiply: ['$payBank', '$paidFactor'] },
            { $cond: [{ $in: ['$pm', ['bank', 'transfer']] }, '$total', 0] },
          ],
        },
        // Whatever of this invoice is still unpaid. Taken from netDue rather than payments.credit
        // or amountDue, both of which can carry the customer's previous balance.
        creditIn: {
          $cond: [
            '$isWholesale',
            { $subtract: ['$netDue', '$applied'] },
            { $cond: [{ $eq: ['$pm', 'credit'] }, '$total', 0] },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        cashIn: { $sum: '$cashIn' },
        cardIn: { $sum: '$cardIn' },
        bankIn: { $sum: '$bankIn' },
        creditIn: { $sum: '$creditIn' },
      },
    },
  ]);

  const [
    ledgerPaymentByMethod,
    ledgerAccountByAccount,
    voidsAgg,
    salePaymentInFromSales,
  ] = await Promise.all([
    agg(
      fastTimeMatch
        ? [{ $match: ledgerDateMatch }, {
          $group: {
            _id: '$method',
            in: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] } },
            out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } }
          }
        }]
        : [
      { $addFields: { ledgerLondonDateKey: { $dateToString: { date: '$occurredAtUtc', format: '%Y-%m-%d', timezone: 'Europe/London' } } } },
      { $match: ledgerDateMatch },
      {
        $group: {
          _id: '$method',
          in: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] } },
          out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } }
        }
      }
    ], PaymentLedgerEntry),
    agg(
      fastTimeMatch
        ? [{ $match: ledgerDateMatch }, {
          $group: {
            _id: '$accountId',
            in: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] } },
            out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } }
          }
        },
        { $lookup: { from: 'payment_accounts', localField: '_id', foreignField: '_id', as: 'account' } },
        { $unwind: { path: '$account', preserveNullAndEmptyArrays: true } },
        { $project: { accountId: '$_id', accountName: '$account.name', type: '$account.type', in: 1, out: 1, net: { $subtract: ['$in', '$out'] } } }]
        : [
      { $addFields: { ledgerLondonDateKey: { $dateToString: { date: '$occurredAtUtc', format: '%Y-%m-%d', timezone: 'Europe/London' } } } },
      { $match: ledgerDateMatch },
      {
        $group: {
          _id: '$accountId',
          in: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] } },
          out: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] } }
        }
      },
      { $lookup: { from: 'payment_accounts', localField: '_id', foreignField: '_id', as: 'account' } },
      { $unwind: { path: '$account', preserveNullAndEmptyArrays: true } },
      { $project: { accountId: '$_id', accountName: '$account.name', type: '$account.type', in: 1, out: 1, net: { $subtract: ['$in', '$out'] } } }
    ], PaymentLedgerEntry),
    agg(
      fastTimeMatch
        ? [{ $match: voidMatch }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }]
        : [
      { $addFields: { voidLondonDateKey: { $dateToString: { date: { $ifNull: ['$voidedAtUtc', '$createdAt'] }, format: '%Y-%m-%d', timezone: 'Europe/London' } } } },
      { $match: voidMatch },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }
    ], Sale),
    agg(salePaymentPipeline, Sale),
  ]);

  const [
    revenueAgg,
    cogsAgg,
    returnRevAgg,
    returnCogsAgg,
    expenseTotalAgg,
    expenseByCatAgg,
  ] = await Promise.all([
    agg(
      fastTimeMatch
        ? [{ $match: saleMatch }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]
        : [
      { $addFields: { londonDateKey: saleLondonDateKey } },
      { $match: saleMatch },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ], Sale),
    lite
      ? Promise.resolve([])
      : agg(
      fastTimeMatch
        ? [{ $match: saleMatch }, { $unwind: '$items' }, { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] } } } }]
        : [
      { $addFields: { londonDateKey: saleLondonDateKey } },
      { $match: saleMatch },
      { $unwind: '$items' },
      { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] } } } },
    ], Sale),
    agg(
      fastTimeMatch
        ? [{ $match: returnMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]
        : [
      { $addFields: { returnLondonDateKey: returnLondonDateKey } },
      { $match: returnMatch },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ], SalesReturn),
    lite
      ? Promise.resolve([])
      : agg(
      fastTimeMatch
        ? [{ $match: returnMatch }, { $unwind: '$items' }, { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_return', 0] }] } } } }]
        : [
      { $addFields: { returnLondonDateKey: returnLondonDateKey } },
      { $match: returnMatch },
      { $unwind: '$items' },
      { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_return', 0] }] } } } },
    ], SalesReturn),
    lite
      ? Promise.resolve([])
      : agg([
      { $match: expenseMatch },
      { $group: { _id: null, total: { $sum: '$amountGross' } } }
    ], Expense),
    lite
      ? Promise.resolve([])
      : agg([
      { $match: expenseMatch },
      { $group: { _id: '$categoryId', totalGross: { $sum: '$amountGross' }, count: { $sum: 1 } } },
      { $lookup: { from: 'expense_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
      { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
      { $project: { categoryName: '$cat.name', totalGross: 1, count: 1, _id: 1 } },
      { $sort: { totalGross: -1 } },
    ], Expense),
  ]);

  // Always read Sale/SalesReturn directly. The LocationDailyMetric/TenantDailyMetric rollups are
  // maintained by fire-and-forget $inc calls, so a dropped increment silently under-reports takings
  // while the payment breakdown and COGS (both live) stay complete — the report then contradicts
  // itself (e.g. gross profit turning negative). Takings is a financial report: source of truth only.
  const grossSales = round2(Number(revenueAgg[0]?.total) || 0);
  const salesCount = Number(revenueAgg[0]?.count) || 0;
  const refundsGross = round2(Number(returnRevAgg[0]?.total) || 0);
  const refundsCount = Number(returnRevAgg[0]?.count) || 0;
  const voidsRow = voidsAgg[0];
  const voidsCount = voidsRow?.count ?? 0;
  const netRevenue = round2(grossSales - refundsGross);

  const ledgerBuckets = mergeLedgerRowsToBuckets(ledgerPaymentByMethod);

  const saleInRow = salePaymentInFromSales && salePaymentInFromSales[0] ? salePaymentInFromSales[0] : {};
  const saleIn = {
    cash: round2(Number(saleInRow.cashIn) || 0),
    card: round2(Number(saleInRow.cardIn) || 0),
    bank: round2(Number(saleInRow.bankIn) || 0),
    credit: round2(Number(saleInRow.creditIn) || 0),
  };

  // IN is always derived from the sales in the period, never from the ledger's period activity.
  // Ledger IN also carries older-invoice settlements and money transfers, so it would not
  // reconcile against gross sales — and which source won used to depend on whether the tenant
  // happened to have payment accounts seeded, making two tenants report differently.
  // OUT stays on the ledger, which records the method actually refunded.
  const paymentBuckets = {
    cash: { in: saleIn.cash, out: ledgerBuckets.cash.out },
    card: { in: saleIn.card, out: ledgerBuckets.card.out },
    bank: { in: saleIn.bank, out: ledgerBuckets.bank.out },
    credit: { in: saleIn.credit, out: ledgerBuckets.credit.out },
  };

  if (refundsGross > 0.01 && sumBucketOut(paymentBuckets) < 0.01) {
    applyProportionalRefundOut(paymentBuckets, refundsGross);
  }

  const paymentBreakdown = {
    cash: {
      in: round2(paymentBuckets.cash.in),
      out: round2(paymentBuckets.cash.out),
      net: round2(paymentBuckets.cash.in - paymentBuckets.cash.out),
    },
    card: {
      in: round2(paymentBuckets.card.in),
      out: round2(paymentBuckets.card.out),
      net: round2(paymentBuckets.card.in - paymentBuckets.card.out),
    },
    bank: {
      in: round2(paymentBuckets.bank.in),
      out: round2(paymentBuckets.bank.out),
      net: round2(paymentBuckets.bank.in - paymentBuckets.bank.out),
    },
    credit: {
      in: round2(paymentBuckets.credit.in),
      out: round2(paymentBuckets.credit.out),
      net: round2(paymentBuckets.credit.in - paymentBuckets.credit.out),
    },
  };

  const accountBreakdown = (ledgerAccountByAccount || []).map((r) => ({
    accountId: r.accountId ? r.accountId.toString() : '',
    accountName: r.accountName || 'Unknown',
    type: r.type || '',
    in: round2(r.in ?? 0),
    out: round2(r.out ?? 0),
    net: round2(Number(r.net) ?? 0)
  }));

  const revenue = round2(grossSales - refundsGross);
  const cogsSales = round2(cogsAgg[0]?.cogs ?? 0);
  const cogsReturnReversal = round2(returnCogsAgg[0]?.cogs ?? 0);
  const cogs = round2(cogsSales - cogsReturnReversal);
  const grossProfit = round2(revenue - cogs);
  const operatingExpenses = round2(expenseTotalAgg[0]?.total ?? 0);
  const netProfit = round2(grossProfit - operatingExpenses);

  const expensesByCategory = (expenseByCatAgg || []).map((row) => ({
    categoryId: row._id,
    categoryName: row.categoryName || 'Uncategorised',
    totalGross: round2(row.totalGross || 0),
    count: row.count || 0
  }));

  let location = { locationId: 'all', name: 'All locations' };
  if (locationIdParam !== 'all' && locationIdParam) {
    const loc = await Location.findById(locationIdParam).select('name').lean();
    location = { locationId: locationIdParam, name: loc?.name || 'Unknown' };
  }

  const data = {
    range: {
      from,
      to,
      timezone: 'Europe/London',
      ...(useUtcRange ? { fromUtc: fromUtc.toISOString(), toUtc: toUtc.toISOString() } : {}),
    },
    location,
    takings: {
      salesCount,
      refundsCount,
      voidsCount,
      grossSales,
      refundsGross,
      netRevenue,
      paymentBreakdown,
      accountBreakdown
    },
    profitAndLoss: {
      revenue,
      cogs,
      grossProfit,
      operatingExpenses,
      netProfit,
      expensesByCategory
    }
  };

  if (!useUtcRange) {
    await redis.setDashboardCache(cacheKeySuffix, data);
  }
  res.status(200).json({ success: true, data });
});
