/**
 * Reports dashboard endpoints using LocationDailyMetric / TenantDailyMetric (fast at 100+ locations).
 * GET /summary and GET /by-location; optional Redis cache 60s TTL.
 */

const mongoose = require('mongoose');
const LocationDailyMetric = require('../models/LocationDailyMetric');
const TenantDailyMetric = require('../models/TenantDailyMetric');
const Location = require('../models/Location');
const Sale = require('../models/Sale');
const Repair = require('../models/Repair');
const asyncHandler = require('../middleware/asyncHandler');
const redis = require('../lib/redis');
const { getUserLocationScope } = require('../utils/dashboardHelpers');
const { canViewHistoricalSales } = require('../utils/salesDateAccess');
const { getLondonDateKey } = require('../utils/dateKey');
const { getTenantIdFromReq } = require('../middleware/auth');

/**
 * GET /api/reports/dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId=all|<id>
 * Sums metrics across dateKey range. locationId=all or omitted → tenant (or user-scoped locations); else single location.
 */
exports.getSummary = asyncHandler(async (req, res) => {
  let from = (req.query.from || '').trim();
  let to = (req.query.to || '').trim();
  if (!canViewHistoricalSales(req.user)) {
    const todayLondon = getLondonDateKey(new Date());
    from = todayLondon;
    to = todayLondon;
  }
  const locationIdParam = (req.query.locationId || 'all').trim().toLowerCase();
  const userScope = getUserLocationScope(req.user);

  if (!from || !to) {
    return res.status(400).json({ success: false, message: 'from and to (YYYY-MM-DD) are required' });
  }

  const tid = getTenantIdFromReq(req);
  const scopeKey = (userScope && userScope.length) ? userScope.sort().join(',') : 'all';
  const cacheKeySuffix = `summary:${tid}:${from}:${to}:${locationIdParam}:${scopeKey}`;
  const cached = await redis.getDashboardCache(cacheKeySuffix);
  if (cached) {
    return res.json({ success: true, data: cached, cached: true });
  }
  let result;

  if (locationIdParam === 'all' || !locationIdParam) {
    if (!userScope || userScope.length === 0) {
      const docs = await TenantDailyMetric.aggregate([
        { $match: { tenantId: tid, dateKey: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          salesRevenueGross: { $sum: '$salesRevenueGross' },
          salesCount: { $sum: '$salesCount' },
          returnsGross: { $sum: '$returnsGross' },
          returnsCount: { $sum: '$returnsCount' },
          repairsOpen: { $sum: '$repairsOpen' },
          repairsOverdue: { $sum: '$repairsOverdue' },
          repairsReady: { $sum: '$repairsReady' },
          repairsCompleted: { $sum: '$repairsCompleted' },
          lowStockCount: { $sum: '$lowStockCount' },
          outOfStockCount: { $sum: '$outOfStockCount' },
        },
      },
    ]);
      result = docs[0] || {
        salesRevenueGross: 0, salesCount: 0, returnsGross: 0, returnsCount: 0,
        repairsOpen: 0, repairsOverdue: 0, repairsReady: 0, repairsCompleted: 0,
        lowStockCount: 0, outOfStockCount: 0,
      };
    } else {
      const scopeObjIds = userScope.map((id) => new mongoose.Types.ObjectId(id));
      const docs = await LocationDailyMetric.aggregate([
        { $match: { tenantId: tid, locationId: { $in: scopeObjIds }, dateKey: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            salesRevenueGross: { $sum: '$salesRevenueGross' },
            salesCount: { $sum: '$salesCount' },
            returnsGross: { $sum: '$returnsGross' },
            returnsCount: { $sum: '$returnsCount' },
            repairsOpen: { $sum: '$repairsOpen' },
            repairsOverdue: { $sum: '$repairsOverdue' },
            repairsReady: { $sum: '$repairsReady' },
            repairsCompleted: { $sum: '$repairsCompleted' },
            lowStockCount: { $sum: '$lowStockCount' },
            outOfStockCount: { $sum: '$outOfStockCount' },
          },
        },
      ]);
      result = docs[0] || {
        salesRevenueGross: 0, salesCount: 0, returnsGross: 0, returnsCount: 0,
        repairsOpen: 0, repairsOverdue: 0, repairsReady: 0, repairsCompleted: 0,
        lowStockCount: 0, outOfStockCount: 0,
      };
    }
  } else if (locationIdParam === 'unknown' || locationIdParam === '__unknown__') {
    result = {
      salesRevenueGross: 0, salesCount: 0, returnsGross: 0, returnsCount: 0,
      repairsOpen: 0, repairsOverdue: 0, repairsReady: 0, repairsCompleted: 0,
      lowStockCount: 0, outOfStockCount: 0,
    };
  } else {
    const requestedId = new mongoose.Types.ObjectId(locationIdParam);
    if (userScope && userScope.length > 0 && !userScope.some((id) => id === locationIdParam)) {
      return res.status(403).json({ success: false, message: 'Not allowed to view this location' });
    }
    const docs = await LocationDailyMetric.aggregate([
      { $match: { tenantId: tid, locationId: requestedId, dateKey: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          salesRevenueGross: { $sum: '$salesRevenueGross' },
          salesCount: { $sum: '$salesCount' },
          returnsGross: { $sum: '$returnsGross' },
          returnsCount: { $sum: '$returnsCount' },
          repairsOpen: { $sum: '$repairsOpen' },
          repairsOverdue: { $sum: '$repairsOverdue' },
          repairsReady: { $sum: '$repairsReady' },
          repairsCompleted: { $sum: '$repairsCompleted' },
          lowStockCount: { $sum: '$lowStockCount' },
          outOfStockCount: { $sum: '$outOfStockCount' },
        },
      },
    ]);
    result = docs[0] || {
      salesRevenueGross: 0, salesCount: 0, returnsGross: 0, returnsCount: 0,
      repairsOpen: 0, repairsOverdue: 0, repairsReady: 0, repairsCompleted: 0,
      lowStockCount: 0, outOfStockCount: 0,
    };
  }

  const data = {
    salesRevenueGross: result.salesRevenueGross ?? 0,
    salesCount: result.salesCount ?? 0,
    returnsGross: result.returnsGross ?? 0,
    returnsCount: result.returnsCount ?? 0,
    repairsOpen: result.repairsOpen ?? 0,
    repairsOverdue: result.repairsOverdue ?? 0,
    repairsReady: result.repairsReady ?? 0,
    repairsCompleted: result.repairsCompleted ?? 0,
    lowStockCount: result.lowStockCount ?? 0,
    outOfStockCount: result.outOfStockCount ?? 0,
  };

  await redis.setDashboardCache(cacheKeySuffix, data);

  res.json({ success: true, data });
});

/**
 * GET /api/reports/dashboard/by-location?from=YYYY-MM-DD&to=YYYY-MM-DD&metric=salesRevenueGross|repairsOverdue|returnsGross|...
 * Returns top 10 and bottom 10 locations by the given metric (summed over date range), with location names.
 */
exports.getByLocation = asyncHandler(async (req, res) => {
  let from = (req.query.from || '').trim();
  let to = (req.query.to || '').trim();
  if (!canViewHistoricalSales(req.user)) {
    const todayLondon = getLondonDateKey(new Date());
    from = todayLondon;
    to = todayLondon;
  }
  const metric = (req.query.metric || 'salesRevenueGross').trim();
  const userScope = getUserLocationScope(req.user);

  const allowedMetrics = [
    'salesRevenueGross', 'salesCount', 'returnsGross', 'returnsCount',
    'repairsOpen', 'repairsOverdue', 'repairsReady', 'repairsCompleted',
    'lowStockCount', 'outOfStockCount',
  ];
  if (!allowedMetrics.includes(metric)) {
    return res.status(400).json({ success: false, message: `metric must be one of: ${allowedMetrics.join(', ')}` });
  }

  if (!from || !to) {
    return res.status(400).json({ success: false, message: 'from and to (YYYY-MM-DD) are required' });
  }

  const scopeKey = (userScope && userScope.length) ? userScope.sort().join(',') : 'all';
  const tid = getTenantIdFromReq(req);
  const cacheKeySuffix = `by-location:${tid}:${from}:${to}:${metric}:${scopeKey}`;
  const cached = await redis.getDashboardCache(cacheKeySuffix);
  if (cached) {
    return res.json({ success: true, data: cached, cached: true });
  }
  const baseMatch = { tenantId: tid, dateKey: { $gte: from, $lte: to } };
  if (userScope && userScope.length > 0) {
    baseMatch.locationId = { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) };
  }
  const [topRows, bottomRows] = await Promise.all([
    LocationDailyMetric.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$locationId', value: { $sum: `$${metric}` } } },
      { $sort: { value: -1 } },
      { $limit: 10 },
    ]),
    LocationDailyMetric.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$locationId', value: { $sum: `$${metric}` } } },
      { $sort: { value: 1 } },
      { $limit: 10 },
    ]),
  ]);

  const locationIds = [...new Set([
    ...topRows.map((t) => t._id && t._id.toString()),
    ...bottomRows.map((t) => t._id && t._id.toString()),
  ].filter(Boolean))];
  const locationObjectIds = locationIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
  const locations = locationObjectIds.length > 0
    ? await Location.find({ _id: { $in: locationObjectIds } }).select('name').lean()
    : [];
  const nameMap = locations.reduce((acc, l) => {
    acc[l._id.toString()] = l.name || 'Unknown';
    return acc;
  }, {});

  const withNames = (rows) =>
    rows.map((t) => ({
      locationId: t._id ? t._id.toString() : null,
      locationName: t._id ? nameMap[t._id.toString()] || 'Unknown' : 'Unknown',
      value: t.value,
    }));

  const top10 = withNames(topRows);
  const bottom10 = withNames(bottomRows);

  const data = { top: top10, bottom: bottom10, metric };
  await redis.setDashboardCache(cacheKeySuffix, data);

  res.json({ success: true, data });
});

/**
 * GET /api/reports/dashboard/legacy-count
 * Returns count of sales and repairs with locationId=null (legacy data) for warning banner. Scoped by tenant.
 */
exports.getLegacyCount = asyncHandler(async (req, res) => {
  const tid = getTenantIdFromReq(req);
  const saleMatch = { locationId: null, status: { $ne: 'voided' } };
  const repairMatch = { locationId: null };
  if (tid === 'default') {
    saleMatch.$or = [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }];
    repairMatch.$or = [{ tenantId: 'default' }, { tenantId: null }, { tenantId: '' }];
  } else {
    saleMatch.tenantId = tid;
    repairMatch.tenantId = tid;
  }
  const [sales, repairs] = await Promise.all([
    Sale.countDocuments(saleMatch),
    Repair.countDocuments(repairMatch),
  ]);
  res.json({ success: true, data: { sales, repairs } });
});
