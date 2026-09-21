/**
 * Rebuild the sales/returns fields of LocationDailyMetric + TenantDailyMetric from Sale/SalesReturn.
 *
 * These rollups feed the Reports Dashboard. They are maintained by fire-and-forget $inc calls, so a
 * dropped increment leaves them permanently under-reporting (observed: 96 of 170 sales counted).
 * The Takings Dashboard reads Sale/SalesReturn directly, so a stale rollup makes the two pages
 * disagree. This script re-derives the rollups from the source collections.
 *
 * Only salesRevenueGross / salesCount / returnsGross / returnsCount are rewritten. Repair and stock
 * counters are left untouched — they track live state, not per-day events, and cannot be re-derived
 * the same way.
 *
 * Day attribution matches metricsService and the Takings Dashboard exactly:
 *   sale   → occurredAt ?? createdAt, as a Europe/London YYYY-MM-DD
 *   return → occurredAt ?? date ?? createdAt, as a Europe/London YYYY-MM-DD
 * Voided sales are excluded, mirroring the dashboard's `status: { $ne: 'voided' }`.
 *
 * Run:
 *   npm run db:rebuild-daily-metrics -- --tenant=gtl
 *   npm run db:rebuild-daily-metrics -- --tenant=gtl,fonewarehouse --dry-run
 *   npm run db:rebuild-daily-metrics -- --all
 *   npm run db:rebuild-daily-metrics -- --tenant=gtl --from=2026-08-01 --to=2026-09-20
 *
 * --dry-run reports the corrections without writing. Always dry-run a live tenant first.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const LocationDailyMetric = require('../models/LocationDailyMetric');
const TenantDailyMetric = require('../models/TenantDailyMetric');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');

const DB_PREFIX = config.tenantDbPrefix || 'tenant_';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const londonDay = (dateExpr) => ({
  $dateToString: { date: dateExpr, format: '%Y-%m-%d', timezone: 'Europe/London' },
});

function parseArgs(argv) {
  const opts = { tenants: [], all: false, dryRun: false, from: null, to: null };
  for (const arg of argv) {
    if (arg === '--all') opts.all = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--tenant=')) {
      opts.tenants = arg
        .slice('--tenant='.length)
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--from=')) opts.from = arg.slice('--from='.length).trim();
    else if (arg.startsWith('--to=')) opts.to = arg.slice('--to='.length).trim();
  }
  return opts;
}

/** Tenant databases on this cluster, by the configured prefix. */
async function listTenantIds() {
  const admin = mongoose.connection.db.admin();
  const { databases } = await admin.listDatabases();
  return databases
    .map((d) => d.name)
    .filter((n) => n.startsWith(DB_PREFIX))
    .map((n) => n.slice(DB_PREFIX.length))
    .sort();
}

/** `${locationId || ''}|${dateKey}` — '' keys the rows with no location. */
const rowKey = (locationId, dateKey) => `${locationId ? locationId.toString() : ''}|${dateKey}`;

async function collectTotals(tenantId) {
  const [saleRows, returnRows] = await Promise.all([
    Sale.aggregate([
      { $match: { tenantId, status: { $ne: 'voided' } } },
      {
        $group: {
          _id: {
            locationId: '$locationId',
            dateKey: londonDay({ $ifNull: ['$occurredAt', '$createdAt'] }),
          },
          salesRevenueGross: { $sum: '$total' },
          salesCount: { $sum: 1 },
        },
      },
    ]),
    SalesReturn.aggregate([
      { $match: { tenantId } },
      {
        $group: {
          _id: {
            locationId: '$locationId',
            dateKey: londonDay({ $ifNull: ['$occurredAt', { $ifNull: ['$date', '$createdAt'] }] }),
          },
          returnsGross: { $sum: '$grandTotal' },
          returnsCount: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byLocation = new Map();
  const byTenant = new Map();

  const blank = () => ({ salesRevenueGross: 0, salesCount: 0, returnsGross: 0, returnsCount: 0 });
  const bump = (map, key, seed, row) => {
    const cur = map.get(key) || { ...seed, ...blank() };
    cur.salesRevenueGross = round2(cur.salesRevenueGross + (row.salesRevenueGross || 0));
    cur.salesCount += row.salesCount || 0;
    cur.returnsGross = round2(cur.returnsGross + (row.returnsGross || 0));
    cur.returnsCount += row.returnsCount || 0;
    map.set(key, cur);
  };

  for (const row of [...saleRows, ...returnRows]) {
    const { locationId, dateKey } = row._id || {};
    if (!dateKey) continue;
    // metricsService only writes a LocationDailyMetric when the event carries a location.
    if (locationId) bump(byLocation, rowKey(locationId, dateKey), { locationId, dateKey }, row);
    bump(byTenant, dateKey, { dateKey }, row);
  }

  return { byLocation, byTenant };
}

/** Rows that exist today but have no source events left — their totals must go back to zero. */
function addStaleRows(existing, wanted, keyOf, seedOf) {
  for (const doc of existing) {
    const key = keyOf(doc);
    if (wanted.has(key)) continue;
    if (!doc.salesRevenueGross && !doc.salesCount && !doc.returnsGross && !doc.returnsCount) continue;
    wanted.set(key, {
      ...seedOf(doc),
      salesRevenueGross: 0,
      salesCount: 0,
      returnsGross: 0,
      returnsCount: 0,
    });
  }
}

async function rebuildTenant(tenantId, opts) {
  const tenantDb = mongoose.connection.useDb(DB_PREFIX + tenantId, { useCache: true });

  return tenantContext.run({ tenantDb, tenantId }, async () => {
    const inWindow = (dateKey) =>
      (!opts.from || dateKey >= opts.from) && (!opts.to || dateKey <= opts.to);

    const { byLocation, byTenant } = await collectTotals(tenantId);

    const dateFilter = {};
    if (opts.from) dateFilter.$gte = opts.from;
    if (opts.to) dateFilter.$lte = opts.to;
    const existingFilter = { tenantId };
    if (opts.from || opts.to) existingFilter.dateKey = dateFilter;

    const [existingLocation, existingTenant] = await Promise.all([
      LocationDailyMetric.find(existingFilter)
        .select('locationId dateKey salesRevenueGross salesCount returnsGross returnsCount')
        .lean(),
      TenantDailyMetric.find(existingFilter)
        .select('dateKey salesRevenueGross salesCount returnsGross returnsCount')
        .lean(),
    ]);

    for (const key of [...byLocation.keys()]) {
      if (!inWindow(byLocation.get(key).dateKey)) byLocation.delete(key);
    }
    for (const key of [...byTenant.keys()]) {
      if (!inWindow(key)) byTenant.delete(key);
    }

    addStaleRows(
      existingLocation,
      byLocation,
      (d) => rowKey(d.locationId, d.dateKey),
      (d) => ({ locationId: d.locationId, dateKey: d.dateKey })
    );
    addStaleRows(existingTenant, byTenant, (d) => d.dateKey, (d) => ({ dateKey: d.dateKey }));

    const beforeLocation = new Map(existingLocation.map((d) => [rowKey(d.locationId, d.dateKey), d]));
    const beforeTenant = new Map(existingTenant.map((d) => [d.dateKey, d]));

    const changed = (prev, next) =>
      round2(prev?.salesRevenueGross) !== round2(next.salesRevenueGross) ||
      (prev?.salesCount || 0) !== next.salesCount ||
      round2(prev?.returnsGross) !== round2(next.returnsGross) ||
      (prev?.returnsCount || 0) !== next.returnsCount;

    const locationOps = [];
    for (const [key, next] of byLocation) {
      if (!changed(beforeLocation.get(key), next)) continue;
      locationOps.push({
        updateOne: {
          filter: { tenantId, locationId: next.locationId, dateKey: next.dateKey },
          update: {
            $set: {
              salesRevenueGross: round2(next.salesRevenueGross),
              salesCount: next.salesCount,
              returnsGross: round2(next.returnsGross),
              returnsCount: next.returnsCount,
              updatedAtUtc: new Date(),
            },
            $setOnInsert: { createdAtUtc: new Date() },
          },
          upsert: true,
        },
      });
    }

    const tenantOps = [];
    for (const [dateKey, next] of byTenant) {
      if (!changed(beforeTenant.get(dateKey), next)) continue;
      tenantOps.push({
        updateOne: {
          filter: { tenantId, dateKey },
          update: {
            $set: {
              salesRevenueGross: round2(next.salesRevenueGross),
              salesCount: next.salesCount,
              returnsGross: round2(next.returnsGross),
              returnsCount: next.returnsCount,
              updatedAtUtc: new Date(),
            },
            $setOnInsert: { createdAtUtc: new Date() },
          },
          upsert: true,
        },
      });
    }

    const totals = [...byTenant.values()].reduce(
      (acc, r) => {
        acc.gross = round2(acc.gross + r.salesRevenueGross);
        acc.count += r.salesCount;
        return acc;
      },
      { gross: 0, count: 0 }
    );
    const wasTotals = existingTenant.reduce(
      (acc, r) => {
        acc.gross = round2(acc.gross + (r.salesRevenueGross || 0));
        acc.count += r.salesCount || 0;
        return acc;
      },
      { gross: 0, count: 0 }
    );

    if (!opts.dryRun) {
      if (locationOps.length) await LocationDailyMetric.bulkWrite(locationOps, { ordered: false });
      if (tenantOps.length) await TenantDailyMetric.bulkWrite(tenantOps, { ordered: false });
    }

    console.log(
      `  ${opts.dryRun ? '[dry-run] would fix' : 'fixed'} ${locationOps.length} location day(s), ` +
        `${tenantOps.length} tenant day(s)`
    );
    console.log(
      `  tenant sales total: ${wasTotals.count} / ${wasTotals.gross.toFixed(2)} ` +
        `→ ${totals.count} / ${totals.gross.toFixed(2)}`
    );

    return { locationOps: locationOps.length, tenantOps: tenantOps.length };
  });
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.all && opts.tenants.length === 0) {
    console.error('Specify --tenant=<id>[,<id>...] or --all. Add --dry-run to preview.');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI or MONGO_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const tenants = opts.all ? await listTenantIds() : opts.tenants;
  console.log(
    `Rebuild daily metrics${opts.dryRun ? ' (dry run)' : ''}: ${tenants.length} tenant(s)` +
      `${opts.from || opts.to ? ` for ${opts.from || 'start'}..${opts.to || 'end'}` : ' (all time)'}`
  );

  let totalOps = 0;
  for (const tenantId of tenants) {
    console.log(`- ${DB_PREFIX}${tenantId}`);
    try {
      const res = await rebuildTenant(tenantId, opts);
      totalOps += res.locationOps + res.tenantOps;
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
  }

  await mongoose.disconnect();
  console.log(
    `Done. ${opts.dryRun ? 'Would update' : 'Updated'} ${totalOps} rollup row(s) across ${tenants.length} tenant(s).`
  );
}

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { run, rebuildTenant, collectTotals, parseArgs };
