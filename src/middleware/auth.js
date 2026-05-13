const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PlatformUser = require('../models/PlatformUser');
const config = require('../config');
const rbacService = require('../services/rbacService');
const activityLogService = require('../services/activityLogService');

// ── User cache: avoids User.findById() on every request (30s TTL) ──
const _userCache = new Map();
const USER_CACHE_TTL_MS = 30 * 1000;

function getCachedUser(userId) {
    const entry = _userCache.get(String(userId));
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
}
function setCachedUser(userId, data) {
    _userCache.set(String(userId), { data, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    if (_userCache.size > 200) {
        const oldest = _userCache.keys().next().value;
        _userCache.delete(oldest);
    }
}

// Protect routes: load user, populate roles, attach permission keys, sync legacy role
// Phase 2: Also enforces subdomain tenant matches user.tenantId (if subdomain resolved).
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Not authorized to access this route'
        });
    }

    try {
        const _t0 = Date.now();
        const decoded = jwt.verify(token, config.jwtSecret);
        const cachedUser = getCachedUser(decoded.id);
        if (cachedUser) {
            req.user = { ...cachedUser };
        } else {
            const dbUser = await User.findById(decoded.id).select('name email isActive roles role assignedLocationIds defaultLocationId tenantId').lean();
            if (dbUser) setCachedUser(decoded.id, dbUser);
            req.user = dbUser;
        }
        const _t1 = Date.now();

        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'User not found'
            });
        }

        // Extract isPlatformAdmin from JWT token (set at login, not re-checked)
        req.user.isPlatformAdmin = decoded.isPlatformAdmin || false;

        if (!req.user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'User account is deactivated'
            });
        }

        // Phase 2: Mismatch protection - if subdomain resolved tenant, user must belong to that tenant
        if (req.resolvedTenant && req.resolvedTenant.tenantId) {
            const userTenantId = (req.user.tenantId || '').trim();
            const resolvedTenantId = String(req.resolvedTenant.tenantId).trim();
            // Allow if user.tenantId matches resolved tenant, or if user.tenantId is empty/null (legacy, default tenant)
            if (userTenantId && userTenantId !== '' && userTenantId !== resolvedTenantId) {
                return res.status(403).json({
                    success: false,
                    message: `User belongs to tenant '${userTenantId}' but subdomain resolves to '${resolvedTenantId}'`,
                    code: 'TENANT_MISMATCH'
                });
            }
        }

        await rbacService.attachPermissionKeys(req.user);
        const _t2 = Date.now();

        // Check tenant suspension (cached 60s to avoid 2 DB queries per request)
        const isPlatformAdmin = (process.env.PLATFORM_ADMIN_EMAILS || '')
            .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
            .includes((req.user.email || '').toLowerCase().trim());
        if (!isPlatformAdmin) {
            const tenantId = req.tenantId || (req.user.tenantId != null && req.user.tenantId !== '' ? String(req.user.tenantId).trim() : null) || 'default';
            let isSuspended = false;

            // In-memory cache for suspension check (avoids 2 raw DB queries per request)
            const now = Date.now();
            const cacheKey = `_susp_${tenantId}`;
            const cached = protect._suspensionCache && protect._suspensionCache.get(cacheKey);
            if (cached && now < cached.expiresAt) {
                isSuspended = cached.suspended;
            } else {
                if (config.platformBaseUrl) {
                    try {
                        const platformEntitlementsCache = require('../services/platformEntitlementsCache');
                        const ent = await platformEntitlementsCache.getEntitlements({ forceRefresh: false });
                        if (ent && String(ent.status || '').toLowerCase() === 'suspended') isSuspended = true;
                    } catch (_) { /* fall back to local */ }
                }
                if (!isSuspended) {
                    const masterDb = mongoose.connection.client.db('inflix_master');
                    let tenant = await masterDb.collection('tenants').findOne(
                        { tenantId },
                        { projection: { status: 1 } }
                    ).catch(() => null);
                    if (!tenant) {
                        const nativeDb = mongoose.connection.client.db();
                        tenant = await nativeDb.collection('tenants').findOne(
                            { tenantId },
                            { projection: { status: 1 } }
                        );
                    }
                    if (tenant && tenant.status === 'suspended') isSuspended = true;
                }
                if (!protect._suspensionCache) protect._suspensionCache = new Map();
                protect._suspensionCache.set(cacheKey, { suspended: isSuspended, expiresAt: now + 60000 });
            }

            if (isSuspended) {
                return res.status(403).json({
                    success: false,
                    message: 'Account suspended. Please contact Inflix - hello@inflix.co.uk',
                    code: 'TENANT_SUSPENDED'
                });
            }
        }

        const _t3 = Date.now();
        // Diagnostic: shows where time is spent — visible in DevTools Network → Response Headers
        res.setHeader('X-Auth-Timing', `user=${_t1 - _t0}ms, rbac=${_t2 - _t1}ms, suspension=${_t3 - _t2}ms, total=${_t3 - _t0}ms`);
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Not authorized to access this route'
        });
    }
};

// Authorize by role names (legacy). Prefer requirePermission for new code.
const authorize = (...roles) => {
    return (req, res, next) => {
        const userRole = (req.user && req.user.role) ? req.user.role.toLowerCase() : '';
        if (!roles.map((r) => r.toLowerCase()).includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: `User role '${req.user.role}' is not authorized to access this route`
            });
        }
        next();
    };
};

// Require at least one of the given permissions. Default deny. Legacy admin role bypasses.
// Logs every 403 to audit_events (user, route, time, IP).
const requirePermission = (...permissionKeys) => {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authorized' });
        }
        if (req.user.role === 'admin') return next();
        for (const key of permissionKeys) {
            if (rbacService.can(req.user, key)) return next();
        }
        const route = `${req.method} ${req.originalUrl || req.path}`;
        try {
            await activityLogService.logFromReq(req, {
                action: 'ACCESS_DENIED',
                entityType: 'Route',
                entityId: route,
                success: false,
                message: `Forbidden: ${route}`,
                metaJson: { requiredPermissions: permissionKeys }
            });
        } catch (e) { /* do not block response */ }
        return res.status(403).json({
            success: false,
            message: 'You do not have permission to perform this action'
        });
    };
};

// Require a single permission.
const requirePerm = (key) => requirePermission(key);

// Require at least one of an array of permissions.
const requireAnyPerm = (keys) => requirePermission(...keys);

// Platform admin: only emails in PLATFORM_ADMIN_EMAILS (comma-separated). Fallback when PlatformUser auth not used.
const requirePlatformAdmin = (req, res, next) => {
    if (!req.user || !req.user.email) {
        return res.status(401).json({ success: false, message: 'Not authorized' });
    }
    const allowlist = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowlist.length === 0) {
        return res.status(503).json({ success: false, message: 'Platform admin not configured' });
    }
    const email = (req.user.email || '').toLowerCase().trim();
    if (!allowlist.includes(email)) {
        return res.status(403).json({ success: false, message: 'Platform admin access only' });
    }
    next();
};

/** Platform auth: valid platform JWT only. Token from X-Platform-Auth: Bearer <token> or Authorization: Bearer <token>. */
const requirePlatformAuth = async (req, res, next) => {
    let token;
    const platformHeader = req.headers['x-platform-auth'];
    if (platformHeader && platformHeader.startsWith('Bearer ')) {
        token = platformHeader.split(' ')[1];
    }
    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return res.status(401).json({ success: false, message: 'Platform authentication required' });
    }
    const secret = config.platformJwtSecret || config.jwtSecret;
    try {
        const decoded = jwt.verify(token, secret);
        if (decoded.aud !== 'platform') {
            return res.status(401).json({ success: false, message: 'Invalid platform token' });
        }
        const platformUser = await PlatformUser.findById(decoded.id).select('email role isActive');
        if (!platformUser) {
            return res.status(401).json({ success: false, message: 'Platform user not found' });
        }
        if (!platformUser.isActive) {
            return res.status(401).json({ success: false, message: 'Platform account is deactivated' });
        }
        req.platformUser = platformUser;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
    }
};

/** Tenant identity: prefer hostname-derived tenantId (set by tenantResolver), fallback to user record. */
function getTenantIdFromReq(req) {
    if (req.tenantId) return req.tenantId;
    const id = req.user && (req.user.tenantId != null && req.user.tenantId !== '') ? String(req.user.tenantId).trim() : null;
    return id || 'default';
}

// Require tenant entitlement for a feature (402 if disabled). Uses req.user.tenantId only.
const requireFeature = (featureKey) => {
    const entitlementsService = require('../services/entitlementsService');
    return async (req, res, next) => {
        const tenantId = getTenantIdFromReq(req);
        try {
            await entitlementsService.assertFeature(tenantId, featureKey);
            next();
        } catch (err) {
            const status = err.status || 402;
            return res.status(status).json({
                success: false,
                message: err.message || `Feature '${featureKey}' is not enabled`,
                code: err.code || 'FEATURE_DISABLED'
            });
        }
    };
};

/** Block write operations if tenant is suspended. Platform admins bypass. Use after protect. */
const requireTenantActive = async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authorized' });
    const tenantId = getTenantIdFromReq(req);
    const isPlatformAdmin = (process.env.PLATFORM_ADMIN_EMAILS || '')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
        .includes((req.user.email || '').toLowerCase().trim());
    if (isPlatformAdmin) return next();
    try {
        const config = require('../config');
        let isSuspended = false;
        if (config.platformBaseUrl) {
            try {
                const platformEntitlementsCache = require('../services/platformEntitlementsCache');
                const ent = await platformEntitlementsCache.getEntitlements({ forceRefresh: true });
                if (ent && String(ent.status || '').toLowerCase() === 'suspended') isSuspended = true;
            } catch (_) { /* fall back to local */ }
        }
        if (!isSuspended) {
            const masterDb = mongoose.connection.client.db('inflix_master');
            let tenant = await masterDb.collection('tenants').findOne(
                { tenantId },
                { projection: { status: 1 } }
            ).catch(() => null);
            if (!tenant) {
                const nativeDb = mongoose.connection.client.db();
                tenant = await nativeDb.collection('tenants').findOne(
                    { tenantId },
                    { projection: { status: 1 } }
                );
            }
            if (tenant && tenant.status === 'suspended') isSuspended = true;
        }
        if (isSuspended) {
            return res.status(403).json({
                success: false,
                message: 'Account suspended. Please contact Inflix - hello@inflix.co.uk',
                code: 'TENANT_SUSPENDED'
            });
        }
    } catch (e) {
        return next(e);
    }
    next();
};

// Optional: set req.user if valid token present; do not 401 if missing (for routes that allow both anonymous and authenticated)
const optionalProtect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const user = await User.findById(decoded.id).select('name email isActive roles role assignedLocationIds defaultLocationId tenantId');
        if (user && user.isActive) {
            await rbacService.attachPermissionKeys(user);
            req.user = user;
        }
    } catch (e) { /* ignore */ }
    next();
};

module.exports = { protect, authorize, requirePermission, requirePerm, requireAnyPerm, requirePlatformAdmin, requirePlatformAuth, requireFeature, getTenantIdFromReq, requireTenantActive, optionalProtect };
