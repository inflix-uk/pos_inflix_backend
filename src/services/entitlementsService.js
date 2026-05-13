/**
 * Single source of truth for tenant entitlements: plan + overrides.
 * When PLATFORM_BASE_URL is set, enforcement uses platform cache (centralised entitlements + usage).
 */
const config = require('../config');
const FeatureCatalog = require('../models/FeatureCatalog');
const LimitCatalog = require('../models/LimitCatalog');
const PlanCatalog = require('../models/PlanCatalog');
const TenantSubscription = require('../models/TenantSubscription');
const User = require('../models/User');
const Location = require('../models/Location');
const Repair = require('../models/Repair');
const { getLondonMonthRange } = require('../utils/dateKey');

let platformEntitlementsCache;
function getPlatformCache() {
    if (!platformEntitlementsCache) platformEntitlementsCache = require('./platformEntitlementsCache');
    return platformEntitlementsCache;
}
function usePlatform() {
    return !!(config.platformBaseUrl || '').trim();
}

// ── In-memory TTL cache for getEntitlements (avoids 3-5 DB queries per request) ──
const _entitlementCache = new Map(); // key: tenantId → { data, expiresAt }
const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCachedEntitlements(tenantId) {
    const entry = _entitlementCache.get(tenantId);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
}
function setCachedEntitlements(tenantId, data) {
    _entitlementCache.set(tenantId, { data, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
    // Prevent unbounded growth (max 100 tenants in cache)
    if (_entitlementCache.size > 100) {
        const oldest = _entitlementCache.keys().next().value;
        _entitlementCache.delete(oldest);
    }
}

/** Convert Mongoose Map or plain object to plain object { key: value } */
function mapToObject(m) {
    if (!m) return {};
    if (typeof m.toObject === 'function') m = m.toObject();
    if (m instanceof Map) return Object.fromEntries(m);
    if (typeof m === 'object' && m !== null) return m;
    return {};
}

/**
 * Get computed entitlements for a tenant (plan + overrides).
 * When platform configured, returns from platform cache.
 * @param {string} tenantId
 * @returns {Promise<{ enabledFeatures: Record<string, boolean>, limits: Record<string, number|null>, planKey: string }>}
 */
async function getEntitlements(tenantId) {
    if (usePlatform()) {
        const data = await getPlatformCache().getEntitlements();
        return { planKey: data.planKey, enabledFeatures: data.enabledFeatures, limits: data.limits };
    }
    const tid = tenantId || 'default';

    // Return from cache if fresh (avoids 3-5 DB queries per request)
    const cached = getCachedEntitlements(tid);
    if (cached) return cached;

    // First try Platform-synced subscription collection, fallback to legacy model
    const mongoose = require('mongoose');
    const tenantContext = require('../lib/tenantContext');
    const store = tenantContext.getStore();
    const db = (store && store.tenantDb) ? store.tenantDb : mongoose.connection;
    let syncedSub = null;
    try {
        syncedSub = await db.collection('subscription').findOne({ tenantId: tid });
    } catch (e) { /* collection may not exist */ }

    // If Platform synced effective entitlements, use them directly
    if (syncedSub && syncedSub.effective) {
        const result = {
            planKey: syncedSub.planKey || 'starter',
            enabledFeatures: syncedSub.effective.enabledFeatures || {},
            limits: syncedSub.effective.limits || {}
        };
        setCachedEntitlements(tid, result);
        return result;
    }

    const [subscription, plan, featureCatalog, limitCatalog] = await Promise.all([
        syncedSub || TenantSubscription.findOne({ tenantId: tid }).lean(),
        null,
        FeatureCatalog.find({ isActive: true }).select('key defaultEnabled').lean(),
        LimitCatalog.find({ isActive: true }).select('key defaultValue').lean()
    ]);

    const planKey = subscription?.planKey || 'starter';
    const planDoc = await PlanCatalog.findOne({ planKey, isActive: true }).lean();
    const planFeatures = mapToObject(planDoc?.features);
    const planLimits = mapToObject(planDoc?.limits);
    const overrideFeatures = mapToObject(subscription?.overrides?.features);
    const overrideLimits = mapToObject(subscription?.overrides?.limits);

    const enabledFeatures = {};
    featureCatalog.forEach((f) => {
        if (overrideFeatures[f.key] !== undefined) {
            enabledFeatures[f.key] = !!overrideFeatures[f.key];
        } else if (planFeatures[f.key] !== undefined) {
            enabledFeatures[f.key] = !!planFeatures[f.key];
        } else {
            enabledFeatures[f.key] = !!f.defaultEnabled;
        }
    });

    const limits = {};
    limitCatalog.forEach((l) => {
        if (overrideLimits[l.key] !== undefined && overrideLimits[l.key] !== null) {
            const v = overrideLimits[l.key];
            limits[l.key] = typeof v === 'number' ? v : null;
        } else if (planLimits[l.key] !== undefined && planLimits[l.key] !== null) {
            const v = planLimits[l.key];
            limits[l.key] = typeof v === 'number' ? v : null;
        } else {
            limits[l.key] = l.defaultValue != null ? Number(l.defaultValue) : null;
        }
    });

    const result = { enabledFeatures, limits, planKey };
    setCachedEntitlements(tid, result);
    return result;
}

/**
 * Throw if feature is disabled for tenant. Use in middleware or before feature-specific logic.
 * When platform is not used, unknown features are allowed so local/dev works without entitlement records.
 * @param {string} tenantId
 * @param {string} featureKey
 * @throws {Error} with code 'FEATURE_DISABLED' and status 402
 */
async function assertFeature(tenantId, featureKey) {
    const { enabledFeatures } = await getEntitlements(tenantId);
    if (enabledFeatures[featureKey] === true) return;
    if (!usePlatform() && enabledFeatures[featureKey] === undefined) return;
    const err = new Error(`Feature '${featureKey}' is not enabled for this tenant`);
    err.code = 'FEATURE_DISABLED';
    err.status = 402;
    throw err;
}

/**
 * Throw if limit would be exceeded. currentUsage should be the count after the operation.
 * @param {string} tenantId
 * @param {string} limitKey e.g. 'maxUsers', 'maxLocations', 'maxRepairsPerMonth'
 * @param {number} currentUsage usage after the proposed action
 * @throws {Error} with code 'LIMIT_EXCEEDED' and status 402
 */
async function assertLimit(tenantId, limitKey, currentUsage) {
    const { limits } = await getEntitlements(tenantId);
    const max = limits[limitKey];
    if (max == null || typeof max !== 'number') return;
    if (currentUsage > max) {
        const err = new Error(`Limit '${limitKey}' exceeded (${currentUsage} > ${max})`);
        err.code = 'LIMIT_EXCEEDED';
        err.status = 402;
        throw err;
    }
}

/**
 * Get current usage counts for a tenant (for display and for assertLimit).
 * When platform configured, returns from platform cache.
 * @param {string} tenantId
 * @returns {Promise<Record<string, number>>} Keys match limit keys: maxUsers, maxLocations, maxRepairsPerMonth
 */
async function getUsage(tenantId) {
    if (usePlatform()) {
        const data = await getPlatformCache().getEntitlements();
        return data.usage || { usersUsed: 0, locationsUsed: 0, repairsThisMonthUsed: 0 };
    }
    const tid = tenantId || 'default';
    const { start: monthStart, end: monthEnd } = getLondonMonthRange();

    const [usersUsed, locationsUsed, repairsThisMonthUsed] = await Promise.all([
        User.countDocuments({ tenantId: tid }),
        Location.countDocuments({ tenantId: tid, isActive: true }),
        Repair.countDocuments({
            tenantId: tid,
            londonDateKey: { $gte: monthStart, $lte: monthEnd }
        })
    ]);

    return {
        maxUsers: usersUsed,
        maxLocations: locationsUsed,
        maxRepairsPerMonth: repairsThisMonthUsed
    };
}

module.exports = {
    getEntitlements,
    assertFeature,
    assertLimit,
    getUsage,
    mapToObject
};
