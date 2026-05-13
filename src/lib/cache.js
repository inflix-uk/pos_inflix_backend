/**
 * Generic versioned cache helper backed by Redis (with in-memory fallback).
 *
 * Why versioned: invalidation is a single INCR on the namespace's version key.
 * Old cache entries become unreachable instantly without SCAN/DEL.
 *
 *   Key shape: pos:{ns}:{tenantId}:v{version}:{paramsHash}
 *   Version key: pos:ver:{ns}:{tenantId}
 *
 * Usage:
 *   await cached({ ns: 'products:list', tenantId, params: { page, limit, search }, ttlSec: 60 }, async () => {
 *     return await Product.find(...).lean();
 *   });
 *
 *   await bumpNs('products:list', tenantId);   // call this on any mutation
 */

const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL;
const DEFAULT_TENANT = process.env.TENANT_ID || 'default';

let client = null;
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

async function getClient() {
    if (client) return client;
    if (!REDIS_URL) return null;
    try {
        const Redis = require('ioredis');
        client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
        await client.connect();
        return client;
    } catch (e) {
        console.warn('[cache] Redis connect failed; using memory fallback:', e.message);
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
    const c = await getClient();
    const key = versionKey(ns, tenantId);
    if (c) {
        try {
            const raw = await c.get(key);
            return raw ? parseInt(raw, 10) || 0 : 0;
        } catch { return 0; }
    }
    return Number(getMemory().get(key)) || 0;
}

async function bumpNs(ns, tenantId) {
    const c = await getClient();
    const key = versionKey(ns, tenantId);
    if (c) {
        try { await c.incr(key); } catch (_) {}
        return;
    }
    getMemory().incr(key);
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
 *
 * Options:
 *   ns        — namespace, e.g. 'products:list'
 *   tenantId  — tenant scope
 *   params    — object whose stable hash forms part of the key (page/filter/sort)
 *   ttlSec    — TTL in seconds (defaults to 60)
 *   skipCache — if true, bypass entirely (debug)
 */
async function cached(opts, fetcher) {
    const { ns, tenantId, params, ttlSec = 60, skipCache = false } = opts || {};
    if (!ns) throw new Error('cache.cached: ns required');
    if (typeof fetcher !== 'function') throw new Error('cache.cached: fetcher required');
    if (skipCache) return await fetcher();

    const c = await getClient();
    const version = await getVersion(ns, tenantId);
    const key = buildKey(ns, tenantId, version, hashParams(params));

    if (c) {
        try {
            const raw = await c.get(key);
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        const value = await fetcher();
        try {
            await c.setex(key, Math.max(1, Math.floor(ttlSec)), JSON.stringify(value));
        } catch (_) {}
        return value;
    }

    const m = getMemory();
    const hit = m.get(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await fetcher();
    m.set(key, value, ttlSec);
    return value;
}

/** Lower-level helpers for ad-hoc keys (rare). */
async function rawGet(key) {
    const c = await getClient();
    if (c) {
        try { const raw = await c.get(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
    }
    return getMemory().get(key);
}
async function rawSet(key, value, ttlSec = 60) {
    const c = await getClient();
    if (c) { try { await c.setex(key, Math.max(1, ttlSec), JSON.stringify(value)); } catch (_) {} return; }
    getMemory().set(key, value, ttlSec);
}
async function rawDel(key) {
    const c = await getClient();
    if (c) { try { await c.del(key); } catch (_) {} return; }
    getMemory().del(key);
}

function isRedisAvailable() {
    return !!REDIS_URL;
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
