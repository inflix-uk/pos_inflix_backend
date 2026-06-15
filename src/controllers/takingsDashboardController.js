/**
 * Takings Dashboard: unified API for takings by payment method + P&L summary.
 * GET /api/reports/takings-dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId=all|<id>
 * Default period: today (Europe/London). Respects tenantId and location scope.
 */

const mongoose = require('mongoose');
const { getLondonDateKey } = require('../utils/dateKey');
const { canViewHistoricalSales, getTodayLondonBounds } = require('../utils/salesDateAccess');
const { getTenantIdFromReq } = require('../middleware/auth');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const LocationDailyMetric = require('../models/LocationDailyMetric');
const TenantDailyMetric = require('../models/TenantDailyMetric');
const Location = require('../models/Location');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const Expense = require('../models/Expense');
const asyncHandler = require('../middleware/asyncHandler');
const redis = require('../lib/redis');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

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

function sumBucketIn(b) {
  return (b.cash?.in || 0) + (b.card?.in || 0) + (b.bank?.in || 0) + (b.credit?.in || 0);
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
  return {
    $expr: {
      $and: [
        { $gte: [{ $ifNull: ['$occurredAt', '$createdAt'] }, fromUtc] },
        { $lte: [{ $ifNull: ['$occurredAt', '$createdAt'] }, toUtc] },
      ],
    },
  };
}

function voidedBetweenUtc(fromUtc, toUtc) {
  return {
    $expr: {
      $and: [
        { $gte: [{ $ifNull: ['$voidedAtUtc', '$createdAt'] }, fromUtc] },
        { $lte: [{ $ifNull: ['$voidedAtUtc', '$createdAt'] }, toUtc] },
      ],
    },
  };
}

function returnOccurredBetweenUtc(fromUtc, toUtc) {
  return {
    $expr: {
      $and: [
        { $gte: [{ $ifNull: ['$occurredAt', { $ifNull: ['$date', '$createdAt'] }] }, fromUtc] },
        { $lte: [{ $ifNull: ['$occurredAt', { $ifNull: ['$date', '$createdAt'] }] }, toUtc] },
      ],
    },
  };
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
    ? `takingsdash:shift:v1:${tid}:${fromUtc.toISOString()}:${toUtc.toISOString()}:${locationIdParam}:${scopeKey}`
    : `takingsdash:v3:${tid}:${from}:${to}:${locationIdParam}:${scopeKey}`;
  if (!useUtcRange) {
    const cached = await redis.getDashboardCache(cacheKeySuffix);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }
  }

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
  if (!useUtcRange) saleMatch.londonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) saleMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) saleMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) Object.assign(saleMatch, occurredBetweenUtc(fromUtc, toUtc));

  const voidMatch = { tenantId: tid, status: 'voided' };
  if (!useUtcRange) voidMatch.voidLondonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) voidMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) voidMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) Object.assign(voidMatch, voidedBetweenUtc(fromUtc, toUtc));

  const returnMatch = { tenantId: tid };
  if (!useUtcRange) returnMatch.returnLondonDateKey = { $gte: from, $lte: to };
  if (locationIdParam !== 'all' && locationIdParam) returnMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) returnMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];
  if (useUtcRange) Object.assign(returnMatch, returnOccurredBetweenUtc(fromUtc, toUtc));

  const ledgerDateMatch = { tenantId: tid };
  if (!useUtcRange) ledgerDateMatch.ledgerLondonDateKey = { $gte: from, $lte: to };
  else {
    ledgerDateMatch.occurredAtUtc = { $gte: fromUtc, $lte: toUtc };
  }
  if (locationIdParam !== 'all' && locationIdParam) ledgerDateMatch.locationId = new mongoose.Types.ObjectId(locationIdParam);
  else if (userScope && userScope.length > 0) ledgerDateMatch.$or = [{ locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } }, { locationId: null }];

  const [
    metricsRow,
    ledgerPaymentByMethod,
    ledgerAccountByAccount,
    voidsAgg,
    revenueAgg,
    cogsAgg,
    returnRevAgg,
    returnCogsAgg,
    expenseTotalAgg,
    expenseByCatAgg,
    salePaymentInFromSales,
  ] = await Promise.all([
    (() => {
      if (useUtcRange) return Promise.resolve([]);
      if (locationIdParam === 'all' || !locationIdParam) {
        if (userScope && userScope.length > 0) {
          return LocationDailyMetric.aggregate([
            { $match: { tenantId: tid, locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) }, dateKey: { $gte: from, $lte: to } } },
            { $group: { _id: null, salesRevenueGross: { $sum: '$salesRevenueGross' }, salesCount: { $sum: '$salesCount' }, returnsGross: { $sum: '$returnsGross' }, returnsCount: { $sum: '$returnsCount' } } }
          ]);
        }
        return TenantDailyMetric.aggregate([
          { $match: { tenantId: tid, dateKey: { $gte: from, $lte: to } } },
          { $group: { _id: null, salesRevenueGross: { $sum: '$salesRevenueGross' }, salesCount: { $sum: '$salesCount' }, returnsGross: { $sum: '$returnsGross' }, returnsCount: { $sum: '$returnsCount' } } }
        ]);
      }
      return LocationDailyMetric.aggregate([
        { $match: { tenantId: tid, locationId: new mongoose.Types.ObjectId(locationIdParam), dateKey: { $gte: from, $lte: to } } },
        { $group: { _id: null, salesRevenueGross: { $sum: '$salesRevenueGross' }, salesCount: { $sum: '$salesCount' }, returnsGross: { $sum: '$returnsGross' }, returnsCount: { $sum: '$returnsCount' } } }
      ]);
    })(),
    PaymentLedgerEntry.aggregate(
      useUtcRange
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
    ]),
    PaymentLedgerEntry.aggregate(
      useUtcRange
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
    ]),
    Sale.aggregate(
      useUtcRange
        ? [{ $match: voidMatch }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }]
        : [
      { $addFields: { voidLondonDateKey: { $dateToString: { date: { $ifNull: ['$voidedAtUtc', '$createdAt'] }, format: '%Y-%m-%d', timezone: 'Europe/London' } } } },
      { $match: voidMatch },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }
    ]),
    Sale.aggregate(
      useUtcRange
        ? [{ $match: saleMatch }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]
        : [
      { $addFields: { londonDateKey: saleLondonDateKey } },
      { $match: saleMatch },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    Sale.aggregate(
      useUtcRange
        ? [{ $match: saleMatch }, { $unwind: '$items' }, { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] } } } }]
        : [
      { $addFields: { londonDateKey: saleLondonDateKey } },
      { $match: saleMatch },
      { $unwind: '$items' },
      { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_sale', 0] }] } } } },
    ]),
    SalesReturn.aggregate(
      useUtcRange
        ? [{ $match: returnMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]
        : [
      { $addFields: { returnLondonDateKey: returnLondonDateKey } },
      { $match: returnMatch },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]),
    SalesReturn.aggregate(
      useUtcRange
        ? [{ $match: returnMatch }, { $unwind: '$items' }, { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_return', 0] }] } } } }]
        : [
      { $addFields: { returnLondonDateKey: returnLondonDateKey } },
      { $match: returnMatch },
      { $unwind: '$items' },
      { $group: { _id: null, cogs: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unit_cost_at_return', 0] }] } } } },
    ]),
    Expense.aggregate([
      { $match: {
        tenantId: tid,
        status: { $in: ['Approved', 'Paid'] },
        occurredAtUtc: useUtcRange
          ? { $gte: fromUtc, $lte: toUtc }
          : { $gte: new Date(from + 'T00:00:00.000Z'), $lte: new Date(to + 'T23:59:59.999Z') },
      } },
      { $group: { _id: null, total: { $sum: '$amountGross' } } }
    ]),
    Expense.aggregate([
      { $match: {
        tenantId: tid,
        status: { $in: ['Approved', 'Paid'] },
        occurredAtUtc: useUtcRange
          ? { $gte: fromUtc, $lte: toUtc }
          : { $gte: new Date(from + 'T00:00:00.000Z'), $lte: new Date(to + 'T23:59:59.999Z') },
      } },
      { $group: { _id: '$categoryId', totalGross: { $sum: '$amountGross' }, count: { $sum: 1 } } },
      { $lookup: { from: 'expense_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
      { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
      { $project: { categoryName: '$cat.name', totalGross: 1, count: 1, _id: 1 } },
      { $sort: { totalGross: -1 } },
    ]),
    Sale.aggregate(
      (useUtcRange
        ? [{ $match: saleMatch }]
        : [{ $addFields: { londonDateKey: saleLondonDateKey } }, { $match: saleMatch }]
      ).concat([
      {
        $project: {
          isWholesale: { $eq: ['$type', 'wholesale'] },
          payCash: { $ifNull: ['$payments.cash', 0] },
          payCard: { $ifNull: ['$payments.card', 0] },
          payBank: { $ifNull: ['$payments.bank', 0] },
          payCredit: { $ifNull: ['$payments.credit', 0] },
          total: '$total',
          pm: { $ifNull: ['$paymentMethod', 'cash'] },
        },
      },
      {
        $project: {
          cashIn: {
            $cond: [
              '$isWholesale',
              '$payCash',
              { $cond: [{ $eq: ['$pm', 'cash'] }, '$total', 0] },
            ],
          },
          cardIn: {
            $cond: [
              '$isWholesale',
              '$payCard',
              { $cond: [{ $eq: ['$pm', 'card'] }, '$total', 0] },
            ],
          },
          bankIn: {
            $cond: [
              '$isWholesale',
              '$payBank',
              { $cond: [{ $eq: ['$pm', 'bank'] }, '$total', 0] },
            ],
          },
          creditIn: {
            $cond: [
              '$isWholesale',
              '$payCredit',
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
    ])),
  ]);

  // Daily metrics rollup: when the aggregate returns no row (e.g. not backfilled), we must use
  // Sale/SalesReturn aggregates. Using `0 ?? saleTotal` is wrong because 0 is not nullish.
  const hasDailyMetrics = !!(metricsRow && metricsRow[0]);
  const m = hasDailyMetrics ? metricsRow[0] : null;
  const grossSales = round2(
    hasDailyMetrics ? Number(m.salesRevenueGross) || 0 : Number(revenueAgg[0]?.total) || 0
  );
  const salesCount = hasDailyMetrics
    ? Number(m.salesCount) || 0
    : Number(revenueAgg[0]?.count) || 0;
  const refundsGross = round2(
    hasDailyMetrics ? Number(m.returnsGross) || 0 : Number(returnRevAgg[0]?.total) || 0
  );
  const refundsCount = hasDailyMetrics
    ? Number(m.returnsCount) || 0
    : Number(returnRevAgg[0]?.count) || 0;
  const voidsRow = voidsAgg[0];
  const voidsCount = voidsRow?.count ?? 0;
  const netRevenue = round2(grossSales - refundsGross);

  const ledgerBuckets = mergeLedgerRowsToBuckets(ledgerPaymentByMethod);
  const totalLedgerIn = sumBucketIn(ledgerBuckets);
  const totalLedgerOut = sumBucketOut(ledgerBuckets);

  const saleInRow = salePaymentInFromSales && salePaymentInFromSales[0] ? salePaymentInFromSales[0] : {};
  const saleIn = {
    cash: round2(Number(saleInRow.cashIn) || 0),
    card: round2(Number(saleInRow.cardIn) || 0),
    bank: round2(Number(saleInRow.bankIn) || 0),
    credit: round2(Number(saleInRow.creditIn) || 0),
  };
  const totalSaleIn = saleIn.cash + saleIn.card + saleIn.bank + saleIn.credit;

  const paymentBuckets = {
    cash: { in: 0, out: 0 },
    card: { in: 0, out: 0 },
    bank: { in: 0, out: 0 },
    credit: { in: 0, out: 0 },
  };

  const useSaleInFallback = totalLedgerIn < 0.01 && totalSaleIn > 0.01;
  if (useSaleInFallback) {
    paymentBuckets.cash.in = saleIn.cash;
    paymentBuckets.card.in = saleIn.card;
    paymentBuckets.bank.in = saleIn.bank;
    paymentBuckets.credit.in = saleIn.credit;
    paymentBuckets.cash.out = ledgerBuckets.cash.out;
    paymentBuckets.card.out = ledgerBuckets.card.out;
    paymentBuckets.bank.out = ledgerBuckets.bank.out;
    paymentBuckets.credit.out = ledgerBuckets.credit.out;
  } else {
    paymentBuckets.cash = { ...ledgerBuckets.cash };
    paymentBuckets.card = { ...ledgerBuckets.card };
    paymentBuckets.bank = { ...ledgerBuckets.bank };
    paymentBuckets.credit = { ...ledgerBuckets.credit };
  }

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

  const salesRevenue = round2(revenueAgg[0]?.total ?? grossSales);
  const returnRevenue = round2(returnRevAgg[0]?.total ?? refundsGross);
  const revenue = round2(salesRevenue - returnRevenue);
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
