/**
 * Redis client for shared cache (tenant-aware serial lookup).
 * If REDIS_URL not set or Redis hangs, fall back to in-memory so POS scans never stall.
 */
const REDIS_URL = process.env.REDIS_URL;
const TENANT_ID = process.env.TENANT_ID || 'default';
const REDIS_OP_TIMEOUT_MS = Math.max(500, parseInt(process.env.REDIS_OP_TIMEOUT_MS || '2000', 10) || 2000);
const REDIS_DISABLED_BY_ENV = process.env.CACHE_DISABLE_REDIS === '1' || process.env.CACHE_DISABLE_REDIS === 'true';

let client = null;
let redisUnavailable = REDIS_DISABLED_BY_ENV;
let connecting = null;
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

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Redis ${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function disableRedis(reason) {
    if (redisUnavailable) return;
    redisUnavailable = true;
    console.warn('[redis] Disabled for this process; using memory fallback:', reason);
    try {
        if (client) client.disconnect(false);
    } catch (_) {}
    client = null;
    connecting = null;
}

async function getClient() {
    if (redisUnavailable) return null;
    if (client) return client;
    if (!REDIS_URL || REDIS_URL === '') return null;
    if (connecting) return connecting;

    connecting = (async () => {
        try {
            const Redis = require('ioredis');
            const c = new Redis(REDIS_URL, {
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                lazyConnect: true,
                connectTimeout: REDIS_OP_TIMEOUT_MS,
                commandTimeout: REDIS_OP_TIMEOUT_MS,
                retryStrategy: () => null,
            });
            c.on('error', (err) => {
                if (err && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|READONLY/i.test(String(err.message || ''))) {
                    disableRedis(err.message);
                }
            });
            await withTimeout(c.connect(), REDIS_OP_TIMEOUT_MS, 'connect');
            await withTimeout(c.ping(), REDIS_OP_TIMEOUT_MS, 'ping');
            client = c;
            return client;
        } catch (e) {
            disableRedis(e.message || String(e));
            return null;
        } finally {
            connecting = null;
        }
    })();

    return connecting;
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
            const raw = await withTimeout(c.get(key), REDIS_OP_TIMEOUT_MS, 'get');
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            disableRedis(e.message || String(e));
            return getMemoryFallback().get(key);
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
            await withTimeout(c.setex(key, ttl, JSON.stringify(value)), REDIS_OP_TIMEOUT_MS, 'setex');
        } catch (e) {
            disableRedis(e.message || String(e));
            getMemoryFallback().set(key, value);
        }
        return;
    }
    getMemoryFallback().set(key, value);
}

async function del(tenantId, serial) {
    const key = cacheKey(tenantId, serial);
    const c = await getClient();
    if (c) {
        try {
            await withTimeout(c.del(key), REDIS_OP_TIMEOUT_MS, 'del');
        } catch (e) {
            disableRedis(e.message || String(e));
            getMemoryFallback().del(key);
        }
        return;
    }
    getMemoryFallback().del(key);
}

async function mget(tenantId, serials) {
    const keys = serials.map((s) => cacheKey(tenantId, s));
    const c = await getClient();
    if (c) {
        try {
            const raw = await withTimeout(c.mget(...keys), REDIS_OP_TIMEOUT_MS, 'mget');
            return raw.map((r) => (r ? JSON.parse(r) : null));
        } catch (e) {
            disableRedis(e.message || String(e));
            return getMemoryFallback().mget(keys);
        }
    }
    return getMemoryFallback().mget(keys);
}

async function invalidate(tenantId, serial) {
    return del(tenantId, serial);
}

function isRedisAvailable() {
    return !!REDIS_URL && REDIS_URL !== '' && !redisUnavailable;
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
        const raw = await withTimeout(c.get(DASHBOARD_VERSION_KEY_PREFIX + tid), REDIS_OP_TIMEOUT_MS, 'dashboardVersion');
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch (e) {
        disableRedis(e.message || String(e));
        return 0;
    }
}

/** Increment cache version so all existing cached summary/by-location keys become stale (no wildcard delete). */
async function incrDashboardCacheVersion(tenantId) {
    const tid = tenantId || TENANT_ID;
    const c = await getClient();
    if (!c) return;
    try {
        await withTimeout(c.incr(DASHBOARD_VERSION_KEY_PREFIX + tid), REDIS_OP_TIMEOUT_MS, 'dashboardIncr');
    } catch (e) {
        disableRedis(e.message || String(e));
    }
}

async function getDashboardCache(keySuffix) {
    const c = await getClient();
    if (!c) return null;
    try {
        const version = await getDashboardCacheVersion();
        const key = DASHBOARD_CACHE_PREFIX + (keySuffix || '') + ':v' + version;
        const raw = await withTimeout(c.get(key), REDIS_OP_TIMEOUT_MS, 'dashboardGet');
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        disableRedis(e.message || String(e));
        return null;
    }
}

async function setDashboardCache(keySuffix, value) {
    const c = await getClient();
    if (!c) return;
    try {
        const version = await getDashboardCacheVersion();
        const key = DASHBOARD_CACHE_PREFIX + (keySuffix || '') + ':v' + version;
        await withTimeout(c.setex(key, DASHBOARD_CACHE_TTL, JSON.stringify(value)), REDIS_OP_TIMEOUT_MS, 'dashboardSet');
    } catch (e) {
        disableRedis(e.message || String(e));
    }
}

async function invalidateDashboardCache(keySuffixOrPattern) {
    const c = await getClient();
    if (!c) return;
    try {
        const key = keySuffixOrPattern.startsWith(DASHBOARD_CACHE_PREFIX)
            ? keySuffixOrPattern
            : DASHBOARD_CACHE_PREFIX + keySuffixOrPattern;
        if (key.includes('*')) {
            const keys = await withTimeout(c.keys(key), REDIS_OP_TIMEOUT_MS, 'dashboardKeys');
            if (keys.length > 0) await withTimeout(c.del(...keys), REDIS_OP_TIMEOUT_MS, 'dashboardDel');
        } else {
            await withTimeout(c.del(key), REDIS_OP_TIMEOUT_MS, 'dashboardDel');
        }
    } catch (e) {
        disableRedis(e.message || String(e));
    }
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
