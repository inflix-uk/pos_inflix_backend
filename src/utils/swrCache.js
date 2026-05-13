/**
 * Stale-while-revalidate (SWR) in-memory cache.
 *
 * `get(key)` returns `{ value, isStale }` if cached (fresh OR stale within `maxStaleMs`),
 * else `null`. Stale values should be returned to the caller immediately while a
 * background refresh runs via `revalidate(key, fetcher)`.
 *
 * `fetch(key, fetcher)` performs a fresh fetch with concurrent-request de-dup
 * (a thundering herd issues only one underlying call). Use this on cache miss.
 *
 * Result shape: every call returns the same value reference held in the store —
 * callers MUST NOT mutate it. Treat returned data as read-only.
 */
function makeSwrCache({ freshMs, maxStaleMs }) {
    const store = new Map();
    const inflight = new Map();

    function get(key) {
        const e = store.get(key);
        if (!e) return null;
        const age = Date.now() - e.t;
        if (age > maxStaleMs) { store.delete(key); return null; }
        return { value: e.v, isStale: age > freshMs };
    }

    function set(key, value) {
        store.set(key, { t: Date.now(), v: value });
    }

    async function fetch(key, fetcher) {
        const existing = inflight.get(key);
        if (existing) return existing;
        const p = Promise.resolve()
            .then(() => fetcher())
            .then((v) => { store.set(key, { t: Date.now(), v }); return v; })
            .finally(() => { inflight.delete(key); });
        inflight.set(key, p);
        return p;
    }

    function revalidate(key, fetcher) {
        if (inflight.has(key)) return;
        fetch(key, fetcher).catch(() => {/* swallow; stale data already served */});
    }

    function invalidate(key) { if (key == null) store.clear(); else store.delete(key); }

    return { get, set, fetch, revalidate, invalidate };
}

module.exports = { makeSwrCache };
