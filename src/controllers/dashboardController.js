const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const Repair = require('../models/Repair');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Purchase = require('../models/Purchase');
const AuditEvent = require('../models/AuditEvent');
const SerialHistory = require('../models/SerialHistory');
const asyncHandler = require('../middleware/asyncHandler');
const { getDashboardPermissions, getUserLocationScope } = require('../utils/dashboardHelpers');
const { getTenantIdFromReq } = require('../middleware/auth');
const { formatSupplierLabel } = require('../utils/supplierDisplay');
const { computeLowStockRows } = require('./inventoryLowStocksController');

/** Exclude voided sales from dashboard and reporting. */
const ACTIVE_SALE_MATCH = { status: { $ne: 'voided' } };

/**
 * Parse locationId / locationIds from query; if none, use userScope (assigned locations for non-admin).
 * @param {object} query - req.query
 * @param {null | string[]} userScope - getUserLocationScope(req.user): null = all, [] or string[] = allowed IDs
 * @returns {{ locationId: ObjectId } | { locationId: { $in: ObjectId[] } } | null}
 */
const UNKNOWN_LOCATION_VALUE = 'unknown';

function getLocationFilter(query, userScope) {
  const single = (query.locationId || '').trim().toLowerCase();
  const multi = (query.locationIds || '').trim();
  if (single === UNKNOWN_LOCATION_VALUE || single === '__unknown__') {
    return { locationId: null };
  }
  if (single && mongoose.Types.ObjectId.isValid(single)) {
    return { locationId: new mongoose.Types.ObjectId(single) };
  }
  if (multi) {
    const ids = multi.split(',').map((s) => s.trim()).filter(Boolean).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (ids.length > 0) {
      return { locationId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } };
    }
  }
  if (userScope && userScope.length > 0) {
    return { locationId: { $in: userScope.map((id) => new mongoose.Types.ObjectId(id)) } };
  }
  return null;
}
exports.getLocationFilter = getLocationFilter;
exports.UNKNOWN_LOCATION_VALUE = UNKNOWN_LOCATION_VALUE;

/**
 * GET /api/dashboard
 * Query: fromUtc, toUtc (ISO date strings); optional locationId (single) or locationIds (comma-separated).
 * If location filter present: Sale/Repair sections filter by locationId (nulls excluded for single location).
 * Returns only sections the user has permission for.
 */
exports.getDashboard = asyncHandler(async (req, res) => {
  const tenantId = getTenantIdFromReq(req);
  const fromUtc = req.query.fromUtc ? new Date(req.query.fromUtc) : null;
  const toUtc = req.query.toUtc ? new Date(req.query.toUtc) : null;
  const userScope = getUserLocationScope(req.user);
  const locationFilter = getLocationFilter(req.query, userScope);
  const perms = getDashboardPermissions(req.user);
  const result = { kpis: {}, alerts: {}, repairsPipeline: null, recentInvoices: [], lowStock: [], activityPreview: [], topCustomers: [], topProducts: [], salesTimeSeries: [], parcelSummary: null };

  const tenantMatch = { tenantId };
  const mergeTenant = (base) => (Object.keys(base).length ? { $and: [tenantMatch, base] } : tenantMatch);

  const dateMatch = (from, to) => {
    if (!from || !to) return {};
    return {
      $and: [
        { $expr: { $gte: [{ $ifNull: ['$occurredAt', '$createdAt'] }, from] } },
        { $expr: { $lte: [{ $ifNull: ['$occurredAt', '$createdAt'] }, to] } },
      ],
    };
  };
  const mergeLocation = (baseMatch, locMatch) => {
    if (!locMatch || !Object.keys(locMatch).length) return baseMatch;
    return Object.keys(baseMatch).length ? { $and: [baseMatch, locMatch] } : locMatch;
  };
  const repairBase = (match) => mergeLocation(match, locationFilter);

  if (perms.sales && fromUtc && toUtc) {
    const saleMatch = mergeTenant(mergeLocation(mergeLocation(dateMatch(fromUtc, toUtc), locationFilter), ACTIVE_SALE_MATCH));
    const [salesAgg, ordersCount, returnsAgg, outstandingAgg] = await Promise.all([
      Sale.aggregate([
        { $match: saleMatch },
        { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
      Sale.countDocuments(saleMatch),
      SalesReturn.aggregate([
        {
          $match: mergeTenant(mergeLocation(
            { $or: [{ occurredAt: { $gte: fromUtc, $lte: toUtc } }, { occurredAt: null, createdAt: { $gte: fromUtc, $lte: toUtc } }] },
            locationFilter
          ))
        },
        { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
      Customer.aggregate([{ $match: { ...tenantMatch, balance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
    ]);
    result.kpis.salesToday = salesAgg[0]?.total ?? 0;
    result.kpis.ordersToday = ordersCount;
    result.kpis.returnsToday = returnsAgg[0]?.total ?? 0;
    result.kpis.returnsCount = returnsAgg[0]?.count ?? 0;
    result.kpis.outstandingCredit = outstandingAgg[0]?.total ?? 0;
  }

  // Low stock: shared with /api/inventory/low-stocks (StockBalance + SerialLocation, per-product threshold).
  // Cached on result for reuse below by the lowStock list and alerts.
  let _lowStockComputed = null;
  if (perms.inventory) {
    try {
      const singleLocId = (req.query.locationId || '').toString().trim();
      const locationIdForLowStock = singleLocId && singleLocId !== 'unknown' && mongoose.Types.ObjectId.isValid(singleLocId)
        ? singleLocId
        : null;
      _lowStockComputed = await computeLowStockRows({ locationId: locationIdForLowStock });
      result.kpis.lowStockCount = _lowStockComputed.rows.length;
      result.kpis.outOfStockCount = _lowStockComputed.rows.filter((r) => r.status === 'out_of_stock').length;
      result.kpis.imeiExceptionsCount = 0;
    } catch (err) {
      result.kpis.lowStockCount = 0;
      result.kpis.outOfStockCount = 0;
      result.kpis.imeiExceptionsCount = 0;
    }
  }

  if (perms.repairs) {
    const openStatuses = ['pending', 'in_progress', 'waiting_parts', 'completed', 'redo'];
    const repairMatch = mergeTenant(locationFilter || {});
    const pipelineStages = locationFilter ? [{ $match: repairMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }] : [{ $match: tenantMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }];
    const [openCount, dueTodayCount, readyCount, awaitingPartsCount, pipeline] = await Promise.all([
      Repair.countDocuments(repairBase({ ...tenantMatch, status: { $in: openStatuses } })),
      Repair.countDocuments(repairBase({ ...tenantMatch, status: { $in: ['pending', 'in_progress', 'redo'] }, receivedAt: { $ne: null } })),
      Repair.countDocuments(repairBase({ ...tenantMatch, status: 'completed' })),
      Repair.countDocuments(repairBase({ ...tenantMatch, status: 'waiting_parts' })),
      Repair.aggregate(pipelineStages),
    ]);
    result.kpis.openRepairs = openCount;
    result.kpis.dueTodayOverdue = dueTodayCount;
    result.kpis.readyForPickup = readyCount;
    result.kpis.awaitingParts = awaitingPartsCount;
    const pipelineMap = pipeline.reduce((acc, p) => { acc[p._id] = p.count; return acc; }, {});
    result.repairsPipeline = {
      pending: pipelineMap.pending ?? 0,
      in_progress: pipelineMap.in_progress ?? 0,
      waiting_parts: pipelineMap.waiting_parts ?? 0,
      completed: pipelineMap.completed ?? 0,
      collected: pipelineMap.collected ?? 0,
      cancelled: pipelineMap.cancelled ?? 0,
      redo: pipelineMap.redo ?? 0,
    };
  }

  if (perms.sales) {
    const overdueRepairs = await Repair.countDocuments(repairBase({ ...tenantMatch, status: { $in: ['pending', 'in_progress', 'waiting_parts', 'redo'] } }));
    result.alerts = {
      ...result.alerts,
      overdueRepairs,
      overdueBalancesCount: await Customer.countDocuments({ ...tenantMatch, balance: { $gt: 0 } }),
      lowStockCount: result.kpis.lowStockCount ?? 0,
      negativeStockCount: result.kpis.outOfStockCount ?? 0,
    };
  }

  if (perms.sales && fromUtc && toUtc) {
    const topProductsMatch = mergeTenant(mergeLocation(mergeLocation(dateMatch(fromUtc, toUtc), locationFilter), ACTIVE_SALE_MATCH));
    const topProductsAgg = await Sale.aggregate([
      { $match: topProductsMatch },
      { $unwind: '$items' },
      {
        $group: {
          _id: { $ifNull: ['$items.sku', '$items.name'] },
          sku: { $first: '$items.sku' },
          name: { $first: '$items.name' },
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 10 },
    ]);
    result.topProducts = topProductsAgg.map((p) => ({
      sku: p.sku || '',
      name: p.name || '',
      totalQuantity: p.totalQuantity || 0,
      totalRevenue: p.totalRevenue || 0,
    }));

    // Sales over time: bucket by day in Europe/London timezone.
    const salesSeriesMatch = mergeTenant(mergeLocation(mergeLocation(dateMatch(fromUtc, toUtc), locationFilter), ACTIVE_SALE_MATCH));
    const seriesAgg = await Sale.aggregate([
      { $match: salesSeriesMatch },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: { $ifNull: ['$occurredAt', '$createdAt'] },
              timezone: 'Europe/London',
            },
          },
          total: { $sum: '$total' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    // Fill missing days so the chart has continuous x-axis.
    const seriesMap = new Map(seriesAgg.map((r) => [r._id, { total: r.total || 0, count: r.count || 0 }]));
    const dayMs = 24 * 60 * 60 * 1000;
    const startDay = new Date(Date.UTC(fromUtc.getUTCFullYear(), fromUtc.getUTCMonth(), fromUtc.getUTCDate()));
    const endDay = new Date(Date.UTC(toUtc.getUTCFullYear(), toUtc.getUTCMonth(), toUtc.getUTCDate()));
    const series = [];
    const MAX_BUCKETS = 366; // safety cap (1 year of daily buckets)
    for (let t = startDay.getTime(), i = 0; t <= endDay.getTime() && i < MAX_BUCKETS; t += dayMs, i++) {
      const d = new Date(t);
      const key = d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      const hit = seriesMap.get(key);
      series.push({ date: key, total: hit ? hit.total : 0, count: hit ? hit.count : 0 });
    }
    result.salesTimeSeries = series;
  }

  if (perms.sales) {
    const recentMatch = mergeTenant(mergeLocation(mergeLocation({}, locationFilter), ACTIVE_SALE_MATCH));
    const recent = await Sale.find(recentMatch).sort({ createdAt: -1 }).limit(10).select('reference total type customerName createdAt').lean();
    result.recentInvoices = recent.map((s) => ({
      _id: s._id.toString(),
      reference: s.reference,
      total: s.total,
      type: s.type,
      customerName: s.customerName,
      createdAt: s.createdAt,
    }));
  }

  if (perms.accounts) {
    const topBalances = await Customer.find({ ...tenantMatch, balance: { $gt: 0 } }).sort({ balance: -1 }).limit(5).select('name balance').lean();
    result.topCustomers = topBalances.map((c) => ({ _id: c._id.toString(), name: c.name, balance: c.balance }));
  }

  if (perms.inventory && _lowStockComputed) {
    result.lowStock = _lowStockComputed.rows.slice(0, 10).map((r) => ({
      _id: r.productId.toString(),
      name: r.name,
      sku: r.sku,
      quantity: r.availableQty,
      minStockLevel: r.thresholdUsed,
      supplierName: (r.supplier && r.supplier.displayLabel) || '',
    }));
  }

  // Parcels: Purchase; tenant-scoped.
  if (perms.parcels) {
    const todayStart = fromUtc || new Date();
    const todayEnd = toUtc || new Date();
    const [createdToday, pending] = await Promise.all([
      Purchase.countDocuments({ ...tenantMatch, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Purchase.countDocuments(tenantMatch),
    ]);
    result.parcelSummary = { parcelsCreatedToday: createdToday, pendingDispatch: Math.min(pending, 50) };
  }

  // Activity: AuditEvent; tenant-scoped.
  if (perms.audit) {
    const events = await AuditEvent.find(tenantMatch).sort({ occurredAtUtc: -1 }).limit(20).select('occurredAtUtc action entityType entityId message actorName invoiceNo imei').lean();
    result.activityPreview = events.map((e) => ({
      id: e._id.toString(),
      occurredAtUtc: e.occurredAtUtc,
      action: e.action,
      entityType: e.entityType,
      message: e.message,
      actorName: e.actorName,
      invoiceNo: e.invoiceNo,
      imei: e.imei,
    }));
  }

  res.json({ success: true, data: result });
});

/**
 * GET /api/dashboard/search?q=
 * Global search: IMEI/Serial, Invoice No, Customer, Repair Ref, Parcel/Tracking.
 * Returns only result types the user has permission to see.
 */
exports.globalSearch = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ success: true, data: { results: [] } });
  }
  const tenantId = getTenantIdFromReq(req);
  const tenantMatch = { tenantId };
  const perms = getDashboardPermissions(req.user);
  const results = [];
  const regex = new RegExp(escapeRegex(q), 'i');

  if (perms.sales) {
    const sales = await Sale.find({ ...tenantMatch, reference: regex, ...ACTIVE_SALE_MATCH }).limit(5).select('reference _id').lean();
    sales.forEach((s) => results.push({ type: 'invoice', id: s._id.toString(), label: s.reference, url: `/invoices?ref=${s.reference}` }));
  }
  if (perms.repairs) {
    const repairs = await Repair.find({ ...tenantMatch, reference: regex }).limit(5).select('reference _id').lean();
    repairs.forEach((r) => results.push({ type: 'repair', id: r._id.toString(), label: r.reference, url: `/repairs/edit/${r._id}` }));
  }
  if (perms.sales || perms.accounts) {
    const customers = await Customer.find({ ...tenantMatch, $or: [{ name: regex }, { phone: regex }, { email: regex }] }).limit(5).select('name _id').lean();
    customers.forEach((c) => results.push({ type: 'customer', id: c._id.toString(), label: c.name, url: `/peoples/customers?search=${encodeURIComponent(c.name)}` }));
  }
  if (perms.parcels) {
    const purchases = await Purchase.find({ ...tenantMatch, $or: [{ purchaseNumber: regex }, { parcelNumber: regex }] }).limit(5).select('purchaseNumber parcelNumber _id').lean();
    purchases.forEach((p) => results.push({
      type: 'parcel',
      id: p._id.toString(),
      label: p.parcelNumber || p.purchaseNumber || p._id.toString(),
      url: `/purchases/view/${p._id}`,
    }));
  }
  const serials = await SerialHistory.find({ serialNumber: regex }).limit(3).distinct('serialNumber').lean();
  serials.forEach((serialNumber) => {
    results.push({ type: 'imei', id: serialNumber, label: `Serial: ${serialNumber}`, url: `/inventory/product-history?serial=${encodeURIComponent(serialNumber)}` });
  });

  res.json({ success: true, data: { results } });
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
