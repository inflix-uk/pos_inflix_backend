const mongoose = require('mongoose');
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { validatePassword } = require('../utils/passwordPolicy');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public (first user) / Private (admin only after)
exports.register = asyncHandler(async (req, res) => {
    const { name, email, password, role, phone } = req.body;

    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) {
        return res.status(400).json({
            success: false,
            message: pwdCheck.message
        });
    }

    // Check if this is the first user
    const userCount = await User.countDocuments();

    // If not first user, require auth + user.manage permission or legacy admin role
    if (userCount > 0) {
        if (!req.user) {
            return res.status(403).json({
                success: false,
                message: 'Only admin can register new users'
            });
        }
        const rbac = require('../services/rbacService');
        const isAdmin = req.user.role === 'admin' || rbac.can(req.user, 'user.manage');
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only admin can register new users'
            });
        }
    }

    const { getTenantIdFromReq } = require('../middleware/auth');
    const tenantId = getTenantIdFromReq(req);
    const user = await User.create({
        name,
        email,
        password,
        role: userCount === 0 ? 'admin' : (role || 'cashier'),
        phone,
        tenantId
    });

    const token = user.getSignedJwtToken();

    res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        },
        token
    });
});

const loginLimit = require('../middleware/loginLimit');

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Please provide email and password'
        });
    }

    const ip = (req.headers && req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : (req.connection && req.connection.remoteAddress) || '';
    const userAgent = (req.headers && req.headers['user-agent']) || '';

    const normalizedEmail = String(email).toLowerCase().trim();
    if (loginLimit.isLockedOut(normalizedEmail)) {
        const remainingMs = loginLimit.getRemainingLockoutMs(normalizedEmail);
        await activityLogService.logAuthEvent({
            action: 'LOGIN_FAILED',
            entityId: normalizedEmail,
            success: false,
            message: 'Account temporarily locked due to repeated failed logins',
            ipAddress: ip,
            userAgent,
            meta: { email: normalizedEmail, lockoutRemainingMs: remainingMs }
        });
        return res.status(429).json({
            success: false,
            message: `Too many failed attempts. Try again in ${Math.ceil(remainingMs / 60000)} minutes.`
        });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (!user) {
        loginLimit.recordFailedLogin(normalizedEmail);
        await activityLogService.logAuthEvent({
            action: 'LOGIN_FAILED',
            entityId: normalizedEmail,
            success: false,
            message: 'Invalid credentials - user not found',
            ipAddress: ip,
            userAgent,
            meta: { email: normalizedEmail }
        });
        return res.status(401).json({
            success: false,
            message: 'Invalid credentials'
        });
    }

    if (!user.isActive) {
        loginLimit.recordFailedLogin(normalizedEmail);
        await activityLogService.logAuthEvent({
            action: 'LOGIN_FAILED',
            entityId: user._id,
            success: false,
            message: 'Account deactivated',
            ipAddress: ip,
            userAgent,
            meta: { email: normalizedEmail }
        });
        return res.status(401).json({
            success: false,
            message: 'Account is deactivated'
        });
    }

    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
        loginLimit.recordFailedLogin(normalizedEmail);
        await activityLogService.logAuthEvent({
            action: 'LOGIN_FAILED',
            entityId: user._id,
            success: false,
            message: 'Invalid password',
            ipAddress: ip,
            userAgent,
            meta: { email: normalizedEmail }
        });
        return res.status(401).json({
            success: false,
            message: 'Invalid credentials'
        });
    }

    // Phase 2: Validate tenant mismatch before issuing token (if subdomain resolved)
    if (req.resolvedTenant && req.resolvedTenant.tenantId) {
        const userTenantId = (user.tenantId || '').trim();
        const resolvedTenantId = String(req.resolvedTenant.tenantId).trim();
        if (userTenantId && userTenantId !== '' && userTenantId !== resolvedTenantId) {
            loginLimit.recordFailedLogin(normalizedEmail);
            await activityLogService.logAuthEvent({
                action: 'LOGIN_FAILED',
                entityId: user._id,
                success: false,
                message: `User belongs to tenant '${userTenantId}' but subdomain resolves to '${resolvedTenantId}'`,
                ipAddress: ip,
                userAgent,
                meta: { email: normalizedEmail, tenantMismatch: true, userTenantId, resolvedTenantId }
            });
            return res.status(403).json({
                success: false,
                message: `This account belongs to a different tenant. Please access via the correct subdomain.`,
                code: 'TENANT_MISMATCH'
            });
        }
    }

    loginLimit.clearFailedLogins(normalizedEmail);

    // Check if tenant is suspended (before issuing token)
    // When platform is configured, use platform status (source of truth); otherwise check local Tenant
    const config = require('../config');
    const tenantId = user.tenantId || 'default';
    let isSuspended = false;
    if (config.platformBaseUrl) {
        try {
            const platformEntitlementsCache = require('../services/platformEntitlementsCache');
            const ent = await platformEntitlementsCache.getEntitlements({ forceRefresh: true });
            if (ent && String(ent.status || '').toLowerCase() === 'suspended') isSuspended = true;
        } catch (_) {
            // Platform unreachable: fall back to local Tenant check
        }
    }
    if (!isSuspended) {
        // Check inflix_master first (Platform source of truth), then native DB fallback
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
            code: 'TENANT_SUSPENDED',
            suspended: true
        });
    }

    // Update last login
    user.lastLogin = Date.now();
    await user.save({ validateBeforeSave: false });

    // Check platform admin status at login (only checked here, stored in JWT token)
    const platformEmails = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const isPlatformAdmin = platformEmails.length > 0 && user.email && platformEmails.includes((user.email || '').toLowerCase().trim());
    if (process.env.NODE_ENV === 'development' && platformEmails.length > 0) {
        console.log('[login] platform allowlist:', platformEmails.length, 'emails; user:', user.email, '-> isPlatformAdmin:', isPlatformAdmin);
    }

    // Store isPlatformAdmin in JWT token so it's available without re-checking
    const token = user.getSignedJwtToken(isPlatformAdmin);

    await activityLogService.logAuthEvent({
        action: 'LOGIN',
        entityId: user._id,
        userId: user._id,
        actorName: user.name,
        actorRole: user.role,
        success: true,
        message: 'Login successful',
        ipAddress: ip,
        userAgent
    });

    res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isPlatformAdmin: !!isPlatformAdmin,
            suspended: false
        },
        token
    });
});

// @desc    Get current logged in user (with permission keys for RBAC UI). Uses req.user already set by protect + cache.
// @route   GET /api/auth/me
// @access  Private
exports.getMe = asyncHandler(async (req, res) => {
    const permissionKeys = req.user.permissionKeys ? Array.from(req.user.permissionKeys) : [];
    const assignedLocationIds = (req.user.assignedLocationIds || []).map((id) => (id && id.toString ? id.toString() : String(id)));
    const defaultLocationId = req.user.defaultLocationId ? (req.user.defaultLocationId.toString ? req.user.defaultLocationId.toString() : String(req.user.defaultLocationId)) : null;
    // isPlatformAdmin is set at login and stored in JWT token, no re-check needed
    const isPlatformAdmin = req.user.isPlatformAdmin || false;
    const data = {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role || '',
        permissionKeys,
        assignedLocationIds,
        defaultLocationId,
        isPlatformAdmin: !!isPlatformAdmin,
        tenantId: req.user.tenantId != null ? String(req.user.tenantId) : 'default',
        suspended: false,
    };
    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Exchange platform one-time token for tenant JWT (cross-domain login handoff).
// @route   POST /api/auth/platform-callback
// @access  Public
exports.platformCallback = asyncHandler(async (req, res) => {
    const { token: platformToken } = req.body || {};
    const config = require('../config');
    if (!platformToken || typeof platformToken !== 'string') {
        return res.status(400).json({ success: false, message: 'token is required' });
    }
    if (!config.platformSharedSecret) {
        return res.status(503).json({ success: false, message: 'Platform login not configured' });
    }
    let payload;
    try {
        payload = require('jsonwebtoken').verify(platformToken, config.platformSharedSecret, { algorithms: ['HS256'] });
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    if (payload.purpose !== 'tenant_login' || !payload.tenantId || !payload.email) {
        return res.status(400).json({ success: false, message: 'Invalid token payload' });
    }
    if (payload.tenantId !== config.tenantId) {
        return res.status(403).json({ success: false, message: 'Token is for a different tenant' });
    }
    const email = String(payload.email).toLowerCase().trim();
    const user = await User.findOne({ email }).select('name email isActive roles role assignedLocationIds defaultLocationId tenantId');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!user.isActive) {
        return res.status(401).json({ success: false, message: 'Account is deactivated' });
    }
    // Check tenant suspension (same as login)
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
            { tenantId: config.tenantId },
            { projection: { status: 1 } }
        ).catch(() => null);
        if (!tenant) {
            const nativeDb = mongoose.connection.client.db();
            tenant = await nativeDb.collection('tenants').findOne(
                { tenantId: config.tenantId },
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
    const rbacService = require('../services/rbacService');
    await rbacService.attachPermissionKeys(user);
    const jwtToken = user.getSignedJwtToken();
    const permissionKeys = user.permissionKeys ? Array.from(user.permissionKeys) : [];
    const assignedLocationIds = (user.assignedLocationIds || []).map((id) => (id && id.toString ? id.toString() : String(id)));
    const defaultLocationId = user.defaultLocationId ? (user.defaultLocationId.toString ? user.defaultLocationId.toString() : String(user.defaultLocationId)) : null;
    const platformEmails = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const isPlatformAdmin = platformEmails.length > 0 && user.email && platformEmails.includes((user.email || '').toLowerCase().trim());
    const data = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || '',
        permissionKeys,
        assignedLocationIds,
        defaultLocationId,
        isPlatformAdmin: !!isPlatformAdmin,
        tenantId: user.tenantId != null ? String(user.tenantId) : 'default',
    };
    res.status(200).json({ success: true, token: jwtToken, data });
});

// @desc    Update password
// @route   PUT /api/auth/updatepassword
// @access  Private
exports.updatePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id).select('+password');

    if (!(await user.matchPassword(currentPassword))) {
        return res.status(401).json({
            success: false,
            message: 'Current password is incorrect'
        });
    }

    const pwdCheck = validatePassword(newPassword);
    if (!pwdCheck.valid) {
        return res.status(400).json({
            success: false,
            message: pwdCheck.message
        });
    }

    user.password = newPassword;
    await user.save();

    const token = user.getSignedJwtToken();

    res.status(200).json({
        success: true,
        message: 'Password updated successfully',
        token
    });
});

// @desc    Logout user (client-side)
// @route   POST /api/auth/logout
// @access  Private
exports.logout = asyncHandler(async (req, res) => {
    if (req.user) {
        const ip = (req.headers && req.headers['x-forwarded-for'])
            ? req.headers['x-forwarded-for'].split(',')[0].trim()
            : (req.connection && req.connection.remoteAddress) || '';
        await activityLogService.logAuthEvent({
            action: 'LOGOUT',
            entityId: req.user._id,
            userId: req.user._id,
            actorName: req.user.name,
            actorRole: req.user.role,
            success: true,
            message: 'Logout',
            ipAddress: ip,
            userAgent: (req.headers && req.headers['user-agent']) || ''
        });
    }
    res.status(200).json({
        success: true,
        message: 'Logged out successfully'
    });
});
