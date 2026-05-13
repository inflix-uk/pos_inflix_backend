/**
 * Nightly reconciliation: recompute LocationDailyMetric and TenantDailyMetric
 * for the last 14 days (London dateKey) from Sale and SalesReturn to correct drift.
 *
 * Run via cron: node src/scripts/reconcile-metrics.js
 *
 * Multi-tenant: by default, runs across EVERY tenant listed in inflix_master.tenants
 * (status != 'suspended'). Set TENANT_ID=<id> to limit to one tenant; or set
 * TENANT_IDS=<csv> to limit to a list.
 *
 * Repair metrics (open/overdue/ready/completed) are event-driven and not backfilled here.
 */

const mongoose = require('mongoose');
const { getLondonDateKey } = require('../utils/dateKey');
const tenantContext = require('../lib/tenantContext');
const config = require('../config');
const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const LocationDailyMetric = require('../models/LocationDailyMetric');
const TenantDailyMetric = require('../models/TenantDailyMetric');
const redis = require('../lib/redis');

const DAYS = 14;
const DB_PREFIX = config.tenantDbPrefix || 'tenant_';

function getDateKeysLastN(n) {
    const keys = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);
        keys.push(getLondonDateKey(d));
    }
    return keys;
}

/** Reconcile a single tenant. Models route to tenantDb via tenantContext. */
async function reconcileOneTenant(tenantId) {
    const dbName = DB_PREFIX + tenantId;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });

    return tenantContext.run({ tenantDb, tenantId }, async () => {
        const dateKeys = getDateKeysLastN(DAYS);

        const now = new Date();
        const fourteenDaysAgo = new Date(now);
        fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - DAYS);

        const sales = await Sale.find({
            status: { $ne: 'voided' },
            $or: [
                { occurredAt: { $gte: fourteenDaysAgo } },
                { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { createdAt: { $gte: fourteenDaysAgo } }] },
            ],
        }).select('total locationId occurredAt createdAt').lean();

        const returns = await SalesReturn.find({
            $or: [
                { occurredAt: { $gte: fourteenDaysAgo } },
                { $and: [{ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }, { createdAt: { $gte: fourteenDaysAgo } }] },
            ],
        }).select('grandTotal locationId occurredAt createdAt').lean();

        const salesByDateLoc = {};
        const salesByDateTenant = {};
        const returnsByDateLoc = {};
        const returnsByDateTenant = {};

        for (const s of sales) {
            const d = s.occurredAt || s.createdAt;
            const key = getLondonDateKey(d);
            if (!dateKeys.includes(key)) continue;
            salesByDateTenant[key] = salesByDateTenant[key] || { salesRevenueGross: 0, salesCount: 0 };
            salesByDateTenant[key].salesRevenueGross += Number(s.total) || 0;
            salesByDateTenant[key].salesCount += 1;
            const locId = s.locationId || null;
            if (locId) {
                salesByDateLoc[key] = salesByDateLoc[key] || {};
                const lid = locId.toString();
                salesByDateLoc[key][lid] = salesByDateLoc[key][lid] || { salesRevenueGross: 0, salesCount: 0 };
                salesByDateLoc[key][lid].salesRevenueGross += Number(s.total) || 0;
                salesByDateLoc[key][lid].salesCount += 1;
            }
        }
        for (const r of returns) {
            const d = r.occurredAt || r.createdAt;
            const key = getLondonDateKey(d);
            if (!dateKeys.includes(key)) continue;
            returnsByDateTenant[key] = returnsByDateTenant[key] || { returnsGross: 0, returnsCount: 0 };
            returnsByDateTenant[key].returnsGross += Number(r.grandTotal) || 0;
            returnsByDateTenant[key].returnsCount += 1;
            const locId = r.locationId || null;
            if (locId) {
                returnsByDateLoc[key] = returnsByDateLoc[key] || {};
                const lid = locId.toString();
                returnsByDateLoc[key][lid] = returnsByDateLoc[key][lid] || { returnsGross: 0, returnsCount: 0 };
                returnsByDateLoc[key][lid].returnsGross += Number(r.grandTotal) || 0;
                returnsByDateLoc[key][lid].returnsCount += 1;
            }
        }

        let tenantUpserts = 0;
        let locationUpserts = 0;
        for (const dateKey of dateKeys) {
            const tenantSales = salesByDateTenant[dateKey] || { salesRevenueGross: 0, salesCount: 0 };
            const tenantReturns = returnsByDateTenant[dateKey] || { returnsGross: 0, returnsCount: 0 };

            await TenantDailyMetric.findOneAndUpdate(
                { tenantId, dateKey },
                {
                    $set: {
                        salesRevenueGross: tenantSales.salesRevenueGross ?? 0,
                        salesCount: tenantSales.salesCount ?? 0,
                        returnsGross: tenantReturns.returnsGross ?? 0,
                        returnsCount: tenantReturns.returnsCount ?? 0,
                        updatedAtUtc: new Date(),
                    },
                },
                { upsert: true }
            );
            tenantUpserts += 1;

            const salesLoc = salesByDateLoc[dateKey] || {};
            const returnsLoc = returnsByDateLoc[dateKey] || {};
            const locIds = new Set([...Object.keys(salesLoc), ...Object.keys(returnsLoc)]);
            for (const lid of locIds) {
                const saleRow = salesLoc[lid] || { salesRevenueGross: 0, salesCount: 0 };
                const returnRow = returnsLoc[lid] || { returnsGross: 0, returnsCount: 0 };
                const locationId = new mongoose.Types.ObjectId(lid);
                await LocationDailyMetric.findOneAndUpdate(
                    { tenantId, locationId, dateKey },
                    {
                        $set: {
                            salesRevenueGross: saleRow.salesRevenueGross ?? 0,
                            salesCount: saleRow.salesCount ?? 0,
                            returnsGross: returnRow.returnsGross ?? 0,
                            returnsCount: returnRow.returnsCount ?? 0,
                            updatedAtUtc: new Date(),
                        },
                    },
                    { upsert: true }
                );
                locationUpserts += 1;
            }
        }

        return { tenantId, dbName, sales: sales.length, returns: returns.length, tenantUpserts, locationUpserts };
    });
}

/** Discover tenants. Order: env override → inflix_master.tenants → fallback to 'default'. */
async function listTenantIds() {
    if (process.env.TENANT_IDS) {
        return process.env.TENANT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (process.env.TENANT_ID) {
        return [process.env.TENANT_ID];
    }
    const masterDb = mongoose.connection.client.db('inflix_master');
    const docs = await masterDb.collection('tenants')
        .find({ status: { $ne: 'suspended' } }, { projection: { tenantId: 1 } })
        .toArray()
        .catch(() => []);
    const ids = docs.map((d) => d.tenantId).filter(Boolean);
    return ids.length ? ids : ['default'];
}

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI required');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
    const startedAt = Date.now();
    let okCount = 0;
    const failures = [];
    try {
        const tenants = await listTenantIds();
        console.log(`[reconcile] starting for ${tenants.length} tenant(s): ${tenants.join(', ')}`);
        for (const tenantId of tenants) {
            try {
                const result = await reconcileOneTenant(tenantId);
                console.log(`[reconcile] OK tenant=${result.tenantId} db=${result.dbName} sales=${result.sales} returns=${result.returns} tenantUpserts=${result.tenantUpserts} locationUpserts=${result.locationUpserts}`);
                okCount += 1;
            } catch (err) {
                console.error(`[reconcile] FAIL tenant=${tenantId}: ${err.message}`);
                failures.push({ tenantId, error: err.message });
            }
        }
        if (redis.invalidateDashboardCacheForMetricsUpdate) {
            await redis.invalidateDashboardCacheForMetricsUpdate().catch(() => {});
        }
    } finally {
        const took = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[reconcile] done in ${took}s: ok=${okCount} failed=${failures.length} (last ${DAYS} days)`);
        if (failures.length) {
            for (const f of failures) console.error(`[reconcile] - ${f.tenantId}: ${f.error}`);
        }
        await mongoose.disconnect();
        if (failures.length) process.exit(1);
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
