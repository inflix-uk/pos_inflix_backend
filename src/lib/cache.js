/**
 * Generic versioned cache helper backed by Redis (with in-memory fallback).
 *
 * Why versioned: invalidation is a single INCR on the namespace's version key.
 * Old cache entries become unreachable instantly without SCAN/DEL.
 *
 *   Key shape: pos:{ns}:{tenantId}:v{version}:{paramsHash}
 *   Version key: pos:ver:{ns}:{tenantId}
 *
 * If Redis is slow or hangs, we disable it for this process and use memory
 * so list endpoints (e.g. sales) never sit on skeletons waiting on Redis.
 */

const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL;
const DEFAULT_TENANT = process.env.TENANT_ID || 'default';
const REDIS_OP_TIMEOUT_MS = Math.max(500, parseInt(process.env.REDIS_OP_TIMEOUT_MS || '2000', 10) || 2000);
const REDIS_DISABLED_BY_ENV = process.env.CACHE_DISABLE_REDIS === '1' || process.env.CACHE_DISABLE_REDIS === 'true';

let client = null;
let redisUnavailable = REDIS_DISABLED_BY_ENV;
let connecting = null;
let memoryStore = null;

function getMemory() {
    if (!memoryStore) {
        const map = new Map();
        memoryStore = {
            get(key) {
                const e = map.get(key);
                if (!e) return null;
                if (e.expiresAt && Date.now() > e.expiresAt) { map.delete(key); return null; }
                return e.value;
            },
            set(key, value, ttlSec) {
                map.set(key, { value, expiresAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
                if (map.size > 5000) {
                    const oldest = map.keys().next().value;
                    if (oldest) map.delete(oldest);
                }
            },
            incr(key) {
                const e = map.get(key);
                const next = (e && Number(e.value)) ? Number(e.value) + 1 : 1;
                map.set(key, { value: next, expiresAt: 0 });
                return next;
            },
            del(key) { map.delete(key); },
        };
    }
    return memoryStore;
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
    console.warn('[cache] Redis disabled for this process; using memory fallback:', reason);
    try {
        if (client) {
            client.disconnect(false);
        }
    } catch (_) {}
    client = null;
    connecting = null;
}

async function getClient() {
    if (redisUnavailable) return null;
    if (client) return client;
    if (!REDIS_URL) return null;
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
                // Avoid unhandled error events; disable on hard failures
                if (err && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|READONLY/i.test(String(err.message || ''))) {
                    disableRedis(err.message);
                }
            });
            await withTimeout(c.connect(), REDIS_OP_TIMEOUT_MS, 'connect');
            // Cheap ping so a half-open Redis does not pass as healthy
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

async function redisCall(label, fn) {
    const c = await getClient();
    if (!c) return null;
    try {
        return await withTimeout(fn(c), REDIS_OP_TIMEOUT_MS, label);
    } catch (e) {
        disableRedis(e.message || String(e));
        return null;
    }
}

function tid(tenantId) { return tenantId || DEFAULT_TENANT; }
function versionKey(ns, tenantId) { return `pos:ver:${ns}:${tid(tenantId)}`; }
function hashParams(params) {
    if (params == null) return 'noparams';
    try {
        const stable = JSON.stringify(params, Object.keys(params).sort());
        return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 16);
    } catch { return 'badparams'; }
}

async function getVersion(ns, tenantId) {
    const key = versionKey(ns, tenantId);
    const raw = await redisCall('getVersion', (c) => c.get(key));
    if (raw != null) return parseInt(raw, 10) || 0;
    if (redisUnavailable || !REDIS_URL) {
        return Number(getMemory().get(key)) || 0;
    }
    return Number(getMemory().get(key)) || 0;
}

async function bumpNs(ns, tenantId) {
    const key = versionKey(ns, tenantId);
    const ok = await redisCall('incr', (c) => c.incr(key));
    if (ok == null) getMemory().incr(key);
}

/** Invalidate multiple namespaces in one call. Each ns is bumped for the given tenant. */
async function bumpMany(namespaces, tenantId) {
    await Promise.all((namespaces || []).map((n) => bumpNs(n, tenantId)));
}

function buildKey(ns, tenantId, version, paramsHash) {
    return `pos:${ns}:${tid(tenantId)}:v${version}:${paramsHash}`;
}

/**
 * Get-or-fetch with TTL. The fetcher is called only on cache miss.
 * Result must be JSON-serialisable.
 */
async function cached(opts, fetcher) {
    const { ns, tenantId, params, ttlSec = 60, skipCache = false } = opts || {};
    if (!ns) throw new Error('cache.cached: ns required');
    if (typeof fetcher !== 'function') throw new Error('cache.cached: fetcher required');
    if (skipCache) return await fetcher();

    const version = await getVersion(ns, tenantId);
    const key = buildKey(ns, tenantId, version, hashParams(params));
    const ttl = Math.max(1, Math.floor(ttlSec));

    const c = await getClient();
    if (c) {
        try {
            const raw = await withTimeout(c.get(key), REDIS_OP_TIMEOUT_MS, 'get');
            if (raw) return JSON.parse(raw);
            const value = await fetcher();
            try {
                await withTimeout(
                    c.setex(key, ttl, JSON.stringify(value)),
                    REDIS_OP_TIMEOUT_MS,
                    'setex'
                );
            } catch (e) {
                disableRedis(e.message || String(e));
            }
            return value;
        } catch (e) {
            disableRedis(e.message || String(e));
            // fall through to memory
        }
    }

    const m = getMemory();
    const hit = m.get(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await fetcher();
    m.set(key, value, ttl);
    return value;
}

/** Lower-level helpers for ad-hoc keys (rare). */
async function rawGet(key) {
    const raw = await redisCall('get', (c) => c.get(key));
    if (typeof raw === 'string' && raw) {
        try { return JSON.parse(raw); } catch { return null; }
    }
    return getMemory().get(key);
}
async function rawSet(key, value, ttlSec = 60) {
    const ok = await redisCall('setex', (c) =>
        c.setex(key, Math.max(1, ttlSec), JSON.stringify(value))
    );
    if (ok == null) getMemory().set(key, value, ttlSec);
}
async function rawDel(key) {
    const ok = await redisCall('del', (c) => c.del(key));
    if (ok == null) getMemory().del(key);
}

function isRedisAvailable() {
    return !!REDIS_URL && !redisUnavailable;
}

module.exports = {
    cached,
    bumpNs,
    bumpMany,
    getVersion,
    rawGet,
    rawSet,
    rawDel,
    isRedisAvailable,
};
