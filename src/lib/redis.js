/**
 * Redis client for shared cache (tenant-aware serial lookup).
 * If REDIS_URL not set, fallback to in-memory cache so dev works without Redis.
 */
const REDIS_URL = process.env.REDIS_URL;
const TENANT_ID = process.env.TENANT_ID || 'default';

let client = null;
let memoryFallback = null;

function getMemoryFallback() {
    if (!memoryFallback) {
        const map = new Map();
        const TTL_MS = 10 * 60 * 1000;
        const NOT_FOUND_TTL_MS = 45 * 1000;
        const getOne = (key) => {
            const entry = map.get(key);
            if (!entry) return null;
            const ttl = entry.status === 'not_found' ? NOT_FOUND_TTL_MS : TTL_MS;
            if (Date.now() - entry.at > ttl) {
                map.delete(key);
                return null;
            }
            return entry.value;
        };
        memoryFallback = {
            get: getOne,
            set: (key, value) => {
                map.set(key, { value, at: Date.now(), status: value?.status });
            },
            del: (key) => { map.delete(key); },
            mget: (keys) => keys.map((k) => getOne(k)),
        };
    }
    return memoryFallback;
}

async function getClient() {
    if (client) return client;
    if (!REDIS_URL || REDIS_URL === '') return null;
    try {
        const Redis = require('ioredis');
        client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
        await client.connect();
        return client;
    } catch (e) {
        console.warn('Redis connect failed, using in-memory fallback:', e.message);
        return null;
    }
}

const CACHE_KEY_PREFIX = 'serial:lookup:';
const TTL_IN_STOCK = 10 * 60;
const TTL_NOT_FOUND = 45;
const TTL_SOLD_ETC = 5 * 60;

function cacheKey(tenantId, serial) {
    return CACHE_KEY_PREFIX + (tenantId || TENANT_ID) + ':' + String(serial).trim();
}

async function get(tenantId, serial) {
    const key = cacheKey(tenantId, serial);
    const c = await getClient();
    if (c) {
        try {
            const raw = await c.get(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }
    return getMemoryFallback().get(key);
}

async function set(tenantId, serial, value) {
    const key = cacheKey(tenantId, serial);
    const status = value?.status || 'not_found';
    const ttl = status === 'not_found' ? TTL_NOT_FOUND : (status === 'in_stock' || status === 'already_sold' ? TTL_IN_STOCK : TTL_SOLD_ETC);
    const c = await getClient();
    if (c) {
        try {
            await c.setex(key, ttl, JSON.stringify(value));
        } catch (_) {}
        return;
    }
    getMemoryFallback().set(key, value);
}

async function del(tenantId, serial) {
    const key = cacheKey(tenantId, serial);
    const c = await getClient();
    if (c) {
        try {
            await c.del(key);
        } catch (_) {}
        return;
    }
    getMemoryFallback().del(key);
}

async function mget(tenantId, serials) {
    const keys = serials.map((s) => cacheKey(tenantId, s));
    const c = await getClient();
    if (c) {
        try {
            const raw = await c.mget(...keys);
            return raw.map((r) => (r ? JSON.parse(r) : null));
        } catch {
            return getMemoryFallback().mget(keys);
        }
    }
    return getMemoryFallback().mget(keys);
}

async function invalidate(tenantId, serial) {
    return del(tenantId, serial);
}

function isRedisAvailable() {
    return !!REDIS_URL && REDIS_URL !== '';
}

const DASHBOARD_CACHE_PREFIX = 'reports:dashboard:';
const DASHBOARD_CACHE_TTL = 60;
const DASHBOARD_VERSION_KEY_PREFIX = 'reports:dashboard:version:';

/** Get current cache version for tenant (used in cache key so old entries are never read after INCR). Returns 0 if Redis unavailable. */
async function getDashboardCacheVersion(tenantId) {
    const tid = tenantId || TENANT_ID;
    const c = await getClient();
    if (!c) return 0;
    try {
        const raw = await c.get(DASHBOARD_VERSION_KEY_PREFIX + tid);
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
        return 0;
    }
}

/** Increment cache version so all existing cached summary/by-location keys become stale (no wildcard delete). */
async function incrDashboardCacheVersion(tenantId) {
    const tid = tenantId || TENANT_ID;
    const c = await getClient();
    if (!c) return;
    try {
        await c.incr(DASHBOARD_VERSION_KEY_PREFIX + tid);
    } catch (_) {}
}

async function getDashboardCache(keySuffix) {
    const c = await getClient();
    if (!c) return null;
    try {
        const version = await getDashboardCacheVersion();
        const key = DASHBOARD_CACHE_PREFIX + (keySuffix || '') + ':v' + version;
        const raw = await c.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

async function setDashboardCache(keySuffix, value) {
    const c = await getClient();
    if (!c) return;
    try {
        const version = await getDashboardCacheVersion();
        const key = DASHBOARD_CACHE_PREFIX + (keySuffix || '') + ':v' + version;
        await c.setex(key, DASHBOARD_CACHE_TTL, JSON.stringify(value));
    } catch (_) {}
}

async function invalidateDashboardCache(keySuffixOrPattern) {
    const c = await getClient();
    if (!c) return;
    try {
        const key = keySuffixOrPattern.startsWith(DASHBOARD_CACHE_PREFIX)
            ? keySuffixOrPattern
            : DASHBOARD_CACHE_PREFIX + keySuffixOrPattern;
        if (key.includes('*')) {
            const keys = await c.keys(key);
            if (keys.length > 0) await c.del(...keys);
        } else {
            await c.del(key);
        }
    } catch (_) {}
}

/** Call when metrics are updated (sale/return/repair/void/edit). INCR version so cached responses are stale; no wildcard scan/delete. */
async function invalidateDashboardCacheForMetricsUpdate() {
    await incrDashboardCacheVersion();
}

module.exports = {
    get,
    set,
    del,
    mget,
    invalidate,
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    isRedisAvailable,
    getTenantId: () => TENANT_ID,
    getDashboardCache,
    setDashboardCache,
    invalidateDashboardCache,
    invalidateDashboardCacheForMetricsUpdate,
    getDashboardCacheVersion,
    incrDashboardCacheVersion,
    DASHBOARD_CACHE_PREFIX,
    DASHBOARD_CACHE_TTL,
};
