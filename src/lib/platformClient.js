/**
 * Server-to-server client for Platform tenant APIs (entitlements + events).
 * Used only when PLATFORM_BASE_URL and PLATFORM_SHARED_SECRET are set.
 */
const config = require('../config');

const TIMEOUT_MS = config.platformTimeoutMs || 5000;

function getBaseUrl() {
    const url = (config.platformBaseUrl || '').trim().replace(/\/+$/, '');
    return url || null;
}

function getHeaders() {
    const secret = config.platformSharedSecret || '';
    const tenantId = config.tenantId || 'default';
    return {
        'Content-Type': 'application/json',
        'X-Platform-Secret': secret,
        'X-Tenant-Id': tenantId
    };
}

/**
 * GET /api/tenant/entitlements
 * @returns {Promise<{ planKey: string, enabledFeatures: Record<string, boolean>, limits: Record<string, number|null>, usage: Record<string, number> }>}
 */
async function fetchPlatformEntitlements() {
    const baseUrl = getBaseUrl();
    if (!baseUrl) {
        const err = new Error('Platform not configured');
        err.code = 'PLATFORM_NOT_CONFIGURED';
        throw err;
    }
    const url = `${baseUrl}/api/tenant/entitlements?tenantId=${encodeURIComponent(config.tenantId || 'default')}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: getHeaders(),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.status === 401) {
            console.error('[platformClient] Entitlements 401 — secret mismatch with platform');
            const err = new Error('Platform secret mismatch');
            err.code = 'PLATFORM_UNAUTHORIZED';
            err.status = 502;
            throw err;
        }
        if (res.status === 404) {
            console.error('[platformClient] Entitlements 404 — tenant not found in platform');
            const err = new Error('Tenant not found in platform');
            err.code = 'PLATFORM_TENANT_NOT_FOUND';
            err.status = 502;
            throw err;
        }
        if (!res.ok) {
            const text = await res.text();
            console.error('[platformClient] Entitlements error', res.status, text);
            const err = new Error(text || `Platform returned ${res.status}`);
            err.status = res.status >= 500 ? 502 : 502;
            throw err;
        }
        const json = await res.json();
        if (!json.success || !json.data) {
            throw new Error(json.message || 'Invalid platform response');
        }
        const data = json.data;
        const u = data.usage || {};
        data.usage = {
            usersUsed: u.usersUsed ?? u.maxUsers ?? 0,
            locationsUsed: u.locationsUsed ?? u.maxLocations ?? 0,
            repairsThisMonthUsed: u.repairsThisMonthUsed ?? u.maxRepairsPerMonth ?? 0
        };
        return data;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            const err = new Error('Platform request timeout');
            err.code = 'PLATFORM_TIMEOUT';
            err.status = 504;
            throw err;
        }
        throw e;
    }
}

/**
 * POST /api/tenant/events. On failure, retries once.
 * @param {string} type - USER_CREATED | USER_DELETED | LOCATION_CREATED | LOCATION_ARCHIVED | REPAIR_CREATED
 * @param {number} [delta=1]
 * @param {object} [meta={}]
 */
async function postPlatformEvent(type, delta = 1, meta = {}) {
    const baseUrl = getBaseUrl();
    if (!baseUrl) return;
    const url = `${baseUrl}/api/tenant/events`;
    const body = JSON.stringify({
        tenantId: config.tenantId || 'default',
        type,
        delta,
        meta: meta || {}
    });
    const attempt = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: getHeaders(),
                body,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.status === 401) {
                console.error('[platformClient] Events 401 — secret mismatch with platform');
                return false;
            }
            if (!res.ok) {
                const text = await res.text();
                console.error('[platformClient] Event failed', type, res.status, text);
                return false;
            }
            return true;
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                console.error('[platformClient] Event timeout', type);
            } else {
                console.error('[platformClient] Event error', type, e.message);
            }
            return false;
        }
    };
    let ok = await attempt();
    if (!ok) {
        ok = await attempt();
        if (!ok) console.warn('[platformClient] Event retry failed', type);
    }
}

function isPlatformConfigured() {
    return !!(getBaseUrl() && (config.platformSharedSecret || '').trim());
}

module.exports = {
    fetchPlatformEntitlements,
    postPlatformEvent,
    isPlatformConfigured,
    getHeaders,
    getBaseUrl
};
