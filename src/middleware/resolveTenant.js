/**
 * Phase 2: Subdomain-based tenant resolution.
 * Resolves tenant from request host/subdomain and stores on req.resolvedTenant.
 * Falls back gracefully for localhost/dev.
 *
 * IMPORTANT: Uses the raw default mongoose connection (NOT the tenant-scoped
 * model proxy) because the tenants collection lives in the central database
 * and this middleware runs before tenant routing is finalised.
 */

const mongoose = require('mongoose');

/**
 * Extract subdomain from host header.
 * Examples:
 *   "gnr.inflix.uk" -> "gnr"
 *   "localhost:5000" -> null (dev fallback)
 *   "api.inflix.uk" -> null (no subdomain, or "api" is reserved)
 *   "127.0.0.1:5000" -> null (dev fallback)
 */
function extractSubdomain(host) {
    if (!host) return null;
    const hostname = host.split(':')[0].toLowerCase().trim();
    // Skip IP addresses and localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return null;
    }
    // Skip if no dots (single domain name)
    const parts = hostname.split('.');
    if (parts.length < 2) return null;
    // First part is subdomain (e.g. "gnr" from "gnr.inflix.uk")
    const subdomain = parts[0];
    // Skip reserved subdomains (api, www, admin, etc.)
    const reserved = ['api', 'www', 'admin', 'platform', 'app', 'mail', 'ftp', 'cdn', 'static'];
    if (reserved.includes(subdomain)) return null;
    // Return subdomain if it looks valid (alphanumeric + hyphens)
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
        return subdomain;
    }
    return null;
}

/**
 * Resolve tenant from host/subdomain.
 * Sets req.resolvedTenant = { tenantId, subdomain, status } or null.
 * For localhost/dev, req.resolvedTenant is null (fallback to user.tenantId in getTenantIdFromReq).
 */
async function resolveTenantFromHost(req, res, next) {
    try {
        // 1. Try Origin header first (works when backend is on a different domain)
        let subdomain = null;
        const origin = (req.headers.origin || '').trim();
        if (origin) {
            try {
                const originHost = new URL(origin).host;
                subdomain = extractSubdomain(originHost);
            } catch (_) {}
        }
        // 2. Fall back to Host header (when backend shares the same domain)
        if (!subdomain) {
            const host = req.get('host') || req.headers.host || '';
            subdomain = extractSubdomain(host);
        }

        // Localhost/dev: no subdomain resolution, fallback to user.tenantId later
        if (!subdomain) {
            req.resolvedTenant = null;
            return next();
        }

        // Subdomain IS the tenantId; DB is tenant_{subdomain}.
        // No lookup needed — derive directly.
        req.resolvedTenant = {
            tenantId: subdomain,
            subdomain: subdomain,
            status: 'active'
        };

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to resolve tenant',
            error: error.message
        });
    }
}

module.exports = { resolveTenantFromHost, extractSubdomain };
