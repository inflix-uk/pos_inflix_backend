/**
 * Event-driven daily metrics for fast dashboard at scale (100+ locations).
 * Updates LocationDailyMetric and TenantDailyMetric with $inc on Sale/Return/Repair events.
 * dateKey is always derived from the actual event timestamp (getLondonDateKey(eventDate)); only fallback to "now" when eventDate is missing.
 */

const { getLondonDateKey } = require('../utils/dateKey');
const LocationDailyMetric = require('../models/LocationDailyMetric');
const TenantDailyMetric = require('../models/TenantDailyMetric');
const redis = require('../lib/redis');

const OPEN_STATUSES = ['pending', 'in_progress', 'waiting_parts', 'redo'];
const REPAIR_BUCKETS = {
  pending: 'repairsOpen',
  in_progress: 'repairsOpen',
  waiting_parts: 'repairsOpen',
  redo: 'repairsOpen',
  completed: 'repairsReady',
  collected: 'repairsCompleted',
  cancelled: null, // decrement only from previous bucket
};

function getRepairBucket(status) {
  return REPAIR_BUCKETS[status] || null;
}

/** dateKey from event timestamp; fallback to now only when eventDate is missing. */
function eventDateKey(eventDate) {
  return getLondonDateKey(eventDate != null ? eventDate : new Date());
}

/**
 * Increment sales metrics. dateKey from occurredAtOrCreatedAt; fallback to now only if missing.
 * Call after Sale is created (outside transaction is ok for metrics).
 */
async function incrementSaleCreated(tenantId, locationId, total, occurredAtOrCreatedAt) {
  const dateKey = eventDateKey(occurredAtOrCreatedAt);
  const amount = Number(total) || 0;
  const tid = tenantId || 'default';

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: { salesRevenueGross: amount, salesCount: 1 }, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: { salesRevenueGross: amount, salesCount: 1 }, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

/**
 * Decrement sales metrics when a sale is voided/deleted. dateKey from sale's occurredAt or createdAt.
 */
async function decrementSaleVoided(tenantId, locationId, total, occurredAtOrCreatedAt) {
  const dateKey = eventDateKey(occurredAtOrCreatedAt);
  const amount = Number(total) || 0;
  const tid = tenantId || 'default';

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: { salesRevenueGross: -amount, salesCount: -1 }, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: { salesRevenueGross: -amount, salesCount: -1 }, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

/**
 * Apply sale total edit delta (newTotal - oldTotal). dateKey from sale's occurredAt or createdAt.
 * Call when sale is updated and total changed.
 */
async function saleTotalEditDelta(tenantId, locationId, occurredAtOrCreatedAt, deltaTotal) {
  const dateKey = eventDateKey(occurredAtOrCreatedAt);
  const delta = Number(deltaTotal) || 0;
  if (delta === 0) return;
  const tid = tenantId || 'default';

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: { salesRevenueGross: delta }, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: { salesRevenueGross: delta }, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

/**
 * Increment returns metrics. dateKey from occurredAtOrCreatedAt; fallback to now only if missing.
 */
async function incrementReturnCreated(tenantId, locationId, grandTotal, occurredAtOrCreatedAt) {
  const dateKey = eventDateKey(occurredAtOrCreatedAt);
  const amount = Number(grandTotal) || 0;
  const tid = tenantId || 'default';

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: { returnsGross: amount, returnsCount: 1 }, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: { returnsGross: amount, returnsCount: 1 }, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

/**
 * On repair create: increment repairsOpen. dateKey from receivedAtOrCreatedAt; fallback to now only if missing.
 */
async function incrementRepairCreated(tenantId, locationId, receivedAtOrCreatedAt) {
  const dateKey = eventDateKey(receivedAtOrCreatedAt);
  const tid = tenantId || 'default';
  const inc = { repairsOpen: 1 };

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: inc, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: inc, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

/**
 * On repair status change: decrement old bucket, increment new bucket.
 * dateKey uses "now" because the event is the status change at current time.
 */
async function repairStatusChange(tenantId, locationId, oldStatus, newStatus) {
  const dateKey = eventDateKey(new Date());
  const tid = tenantId || 'default';
  const oldBucket = getRepairBucket(oldStatus);
  const newBucket = getRepairBucket(newStatus);

  const locInc = {};
  const tenantInc = {};
  if (oldBucket) {
    locInc[oldBucket] = -1;
    tenantInc[oldBucket] = -1;
  }
  if (newBucket) {
    locInc[newBucket] = (locInc[newBucket] || 0) + 1;
    tenantInc[newBucket] = (tenantInc[newBucket] || 0) + 1;
  }
  if (Object.keys(tenantInc).length === 0) return;

  const updates = [
    TenantDailyMetric.findOneAndUpdate(
      { tenantId: tid, dateKey },
      { $inc: tenantInc, $set: { updatedAtUtc: new Date() } },
      { upsert: true, new: true }
    ),
  ];
  if (locationId) {
    updates.push(
      LocationDailyMetric.findOneAndUpdate(
        { tenantId: tid, locationId, dateKey },
        { $inc: locInc, $set: { updatedAtUtc: new Date() } },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(updates);
  redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
}

module.exports = {
  incrementSaleCreated,
  decrementSaleVoided,
  saleTotalEditDelta,
  incrementReturnCreated,
  incrementRepairCreated,
  repairStatusChange,
  getLondonDateKey,
  eventDateKey,
};
