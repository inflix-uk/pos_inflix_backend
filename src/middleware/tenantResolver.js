/**
 * Express middleware that extracts the tenant from the request
 * and wraps the rest of the request in an AsyncLocalStorage context
 * so model proxies route queries to the correct tenant database.
 *
 * Resolution order:
 *   1. X-Tenant-Id header (frontend sends this when backend is on a different domain)
 *   2. Origin header subdomain (e.g. Origin: https://demo.inflix.uk → "demo")
 *   3. Request hostname subdomain (e.g. demo.inflix.uk → "demo")
 *   4. Fallback to TENANT_ID env var (for localhost / development)
 */
const mongoose = require('mongoose');
const config = require('../config');
const tenantContext = require('../lib/tenantContext');

const domain = (config.tenantUrlDomain || process.env.TENANT_URL_DOMAIN || '').toLowerCase();
const fallbackTenantId = config.tenantId || 'default';
const dbPrefix = config.tenantDbPrefix || 'tenant_';

function extractSubdomain(hostname) {
    if (domain && hostname.endsWith('.' + domain)) {
        const sub = hostname.slice(0, -(domain.length + 1));
        if (sub && sub !== 'www') return sub;
    }
    return null;
}

function resolveTenantId(req) {
    // 1. Explicit header from frontend
    const headerTenant = (req.headers['x-tenant-id'] || '').trim().toLowerCase();
    if (headerTenant) return headerTenant;

    // 2. Origin header subdomain (works when backend is on a different domain)
    const origin = (req.headers.origin || '').trim().toLowerCase();
    if (origin) {
        try {
            const originHost = new URL(origin).hostname;
            const sub = extractSubdomain(originHost);
            if (sub) return sub;
        } catch (_) {}
    }

    // 3. Request hostname subdomain (when backend shares the same domain)
    const hostname = (req.hostname || req.headers.host || '').split(':')[0].toLowerCase();
    const sub = extractSubdomain(hostname);
    if (sub) return sub;

    // 4. Fallback
    return fallbackTenantId;
}

function tenantResolver(req, res, next) {
    const tenantId = resolveTenantId(req);
    const dbName = dbPrefix + tenantId;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });

    req.tenantId = tenantId;
    req.tenantDb = tenantDb;

    tenantContext.run({ tenantDb, tenantId }, () => next());
}

module.exports = tenantResolver;
