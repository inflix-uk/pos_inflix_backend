/**
 * In-memory cache for platform entitlements (planKey, enabledFeatures, limits, usage).
 * TTL and max-stale for resilience when platform is down.
 */
const platformClient = require('../lib/platformClient');
const config = require('../config');

const TTL_MS = (config.platformEntitlementsCacheTtlSec || 60) * 1000;
const MAX_STALE_MS = (config.platformEntitlementsMaxStaleSec || 900) * 1000;

let cached = null; // { value, fetchedAt }

/**
 * Get entitlements: from cache if fresh, else fetch from platform.
 * If platform is down and cache is within max-stale, return stale and log warning.
 * Otherwise throw / return 503.
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.forceRefresh] - If true, skip cache and fetch fresh (use for suspension check so it takes effect immediately).
 * @returns {Promise<{ planKey: string, enabledFeatures: Record<string, boolean>, limits: Record<string, number|null>, usage: Record<string, number>, status?: string }>}
 */
async function getEntitlements(opts = {}) {
    if (!platformClient.isPlatformConfigured()) {
        const err = new Error('Platform not configured');
        err.code = 'PLATFORM_NOT_CONFIGURED';
        throw err;
    }
    const now = Date.now();
    const forceRefresh = opts && opts.forceRefresh === true;
    if (!forceRefresh && cached && (now - cached.fetchedAt) < TTL_MS) {
        return cached.value;
    }
    try {
        const value = await platformClient.fetchPlatformEntitlements();
        if (!forceRefresh) cached = { value, fetchedAt: now };
        else cached = { value, fetchedAt: now }; // still update cache so next normal read is fresh
        return value;
    } catch (e) {
        if (forceRefresh) throw e; // suspension check must have fresh status, don't use stale
        if (cached && (now - cached.fetchedAt) < MAX_STALE_MS) {
            console.warn('[platformEntitlementsCache] Platform unavailable, using stale entitlements', e.message);
            return cached.value;
        }
        const err = new Error('Platform unavailable');
        err.code = 'PLATFORM_UNAVAILABLE';
        err.status = 503;
        throw err;
    }
}

/**
 * Invalidate cache (e.g. after config change in tests).
 */
function invalidate() {
    cached = null;
}

module.exports = {
    getEntitlements,
    invalidate
};
