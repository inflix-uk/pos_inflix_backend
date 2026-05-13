const Tenant = require('../models/Tenant');
const TenantSubscription = require('../models/TenantSubscription');
const User = require('../models/User');
const Role = require('../models/Role');
const mongoose = require('mongoose');
const entitlementsService = require('../services/entitlementsService');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { validatePassword } = require('../utils/passwordPolicy');
const { mapToObject } = require('../services/entitlementsService');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const PLATFORM_TENANTS_NS = 'platform:tenants';
const /* deprecated */ PLATFORM_TENANTS_SCOPE = 'global';
async function invalidatePlatformTenantsCache(tenantId) { await cache.bumpNs(PLATFORM_TENANTS_NS, tenantId); }

function toObjectIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.filter((id) => id && mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
}

/** List tenants: Tenant collection + any tenantId that has a TenantSubscription (e.g. default). Ensures multiple tenants can be listed. */
exports.list = asyncHandler(async (req, res) => {
    const list = await cache.cached(
        { ns: PLATFORM_TENANTS_NS, tenantId: getTenantIdFromReq(req), params: {}, ttlSec: TTL.CATALOG },
        async () => {
            const [tenants, allSubs] = await Promise.all([
                Tenant.find({}).sort({ tenantId: 1 }).lean(),
                TenantSubscription.find({}).select('tenantId').lean()
            ]);
            const idsFromTenants = tenants.map((t) => t.tenantId);
            const idsFromSubs = (allSubs || []).map((s) => s.tenantId).filter(Boolean);
            let tenantIds = [...new Set([...idsFromTenants, ...idsFromSubs])].sort();
            if (tenantIds.length === 0) tenantIds = ['default'];
            const subs = await TenantSubscription.find({ tenantId: { $in: tenantIds } }).lean();
            return tenantIds.map((tid) => {
                const tenant = tenants.find((t) => t.tenantId === tid);
                const sub = subs.find((s) => s.tenantId === tid);
                return {
                    tenantId: tid,
                    subdomain: tenant?.subdomain || null,  // Phase 2: Include subdomain in list
                    name: tenant?.name ?? tid,
                    companyName: tenant?.companyName ?? '',
                    email: tenant?.email ?? '',
                    phone: tenant?.phone ?? '',
                    billingAddress: tenant?.billingAddress ?? '',
                    billingEmail: tenant?.billingEmail ?? '',
                    billingAmount: tenant?.billingAmount ?? null,
                    billingCycle: tenant?.billingCycle ?? 'monthly',
                    currency: tenant?.currency ?? 'GBP',
                    status: tenant?.status ?? 'active',
                    planKey: sub ? sub.planKey : null,
                    startDate: sub?.startDate ?? null,
                    expireDate: sub?.expireDate ?? null,
                    overrides: sub ? { features: mapToObject(sub.overrides?.features), limits: mapToObject(sub.overrides?.limits) } : null
                };
            });
        }
    );
    res.status(200).json({ success: true, data: list });
});

/** Create a new tenant: Tenant record + TenantSubscription (default plan). */
exports.createTenant = asyncHandler(async (req, res) => {
    const {
        name,
        companyName,
        email,
        phone,
        billingAddress,
        billingEmail,
        billingAmount,
        billingCycle,
        currency,
        subdomain
    } = req.body || {};
    const displayName = (name || companyName || '').trim() || 'New Tenant';
    const tenantId = `tenant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [existing] = await Tenant.find({ tenantId }).limit(1);
    if (existing) {
        return res.status(400).json({ success: false, message: 'Tenant ID collision; retry' });
    }
    // Phase 2: Validate subdomain if provided
    let normalizedSubdomain = undefined;
    if (subdomain !== undefined && subdomain !== null && subdomain !== '') {
        normalizedSubdomain = String(subdomain).trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalizedSubdomain)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Subdomain must be lowercase alphanumeric with hyphens (e.g. "acme" or "acme-corp")' 
            });
        }
        const existingSubdomain = await Tenant.findOne({ subdomain: normalizedSubdomain });
        if (existingSubdomain) {
            return res.status(400).json({ 
                success: false, 
                message: `Subdomain "${normalizedSubdomain}" is already in use` 
            });
        }
    }
    await Tenant.create({
        tenantId,
        subdomain: normalizedSubdomain,
        name: displayName,
        companyName: (companyName || '').trim() || displayName,
        email: (email || '').trim().toLowerCase(),
        phone: (phone || '').trim(),
        billingAddress: (billingAddress || '').trim(),
        billingEmail: (billingEmail || '').trim().toLowerCase(),
        billingAmount: billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null,
        billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
        currency: (currency || 'GBP').trim() || 'GBP',
        status: 'active'
    });
    const now = new Date();
    await TenantSubscription.findOneAndUpdate(
        { tenantId },
        { $set: { tenantId, planKey: 'starter', overrides: { features: {}, limits: {} }, startDate: now, updatedAtUtc: now } },
        { upsert: true }
    );
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_TENANT_CREATED',
        entityType: 'Tenant',
        entityId: tenantId,
        success: true,
        message: `Tenant created: ${tenantId}`,
        metaJson: { tenantId, name: displayName }
    });
    await invalidatePlatformTenantsCache(getTenantIdFromReq(req));
    res.status(201).json({
        success: true,
        message: 'Tenant created',
        data: { tenantId, name: displayName, status: 'active', planKey: 'starter' }
    });
});

/** Get one tenant details (for platform console edit) */
exports.getTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId }).lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    res.status(200).json({
        success: true,
        data: {
            tenantId: tenant.tenantId,
            subdomain: tenant.subdomain || null,  // Phase 2: Include subdomain in response
            name: tenant.name,
            companyName: tenant.companyName,
            email: tenant.email,
            phone: tenant.phone,
            billingAddress: tenant.billingAddress,
            billingEmail: tenant.billingEmail,
            billingAmount: tenant.billingAmount,
            billingCycle: tenant.billingCycle,
            currency: tenant.currency,
            status: tenant.status,
            createdAtUtc: tenant.createdAtUtc,
            updatedAtUtc: tenant.updatedAtUtc
        }
    });
});

/** Update tenant details (name, contact, billing). Upserts if tenant does not exist (e.g. only TenantSubscription existed). */
exports.updateTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const {
        name,
        companyName,
        email,
        phone,
        billingAddress,
        billingEmail,
        billingAmount,
        billingCycle,
        currency,
        status,
        subdomain
    } = req.body || {};
    let tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
        // Phase 2: Validate subdomain if provided
        let normalizedSubdomain = undefined;
        if (subdomain !== undefined && subdomain !== null && subdomain !== '') {
            normalizedSubdomain = String(subdomain).trim().toLowerCase();
            if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalizedSubdomain)) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Subdomain must be lowercase alphanumeric with hyphens' 
                });
            }
            const existingSubdomain = await Tenant.findOne({ subdomain: normalizedSubdomain, tenantId: { $ne: tenantId } });
            if (existingSubdomain) {
                return res.status(400).json({ 
                    success: false, 
                    message: `Subdomain "${normalizedSubdomain}" is already in use by another tenant` 
                });
            }
        }
        tenant = await Tenant.create({
            tenantId,
            subdomain: normalizedSubdomain,
            name: String(name ?? '').trim() || tenantId,
            companyName: String(companyName ?? '').trim(),
            email: String(email ?? '').trim().toLowerCase(),
            phone: String(phone ?? '').trim(),
            billingAddress: String(billingAddress ?? '').trim(),
            billingEmail: String(billingEmail ?? '').trim().toLowerCase(),
            billingAmount: billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null,
            billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
            currency: String(currency ?? 'GBP').trim() || 'GBP',
            status: status === 'suspended' ? 'suspended' : 'active'
        });
    } else {
        // Phase 2: Validate and update subdomain if provided
        if (subdomain !== undefined) {
            if (subdomain === null || subdomain === '') {
                tenant.subdomain = undefined;  // Clear subdomain
            } else {
                const normalizedSubdomain = String(subdomain).trim().toLowerCase();
                if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalizedSubdomain)) {
                    return res.status(400).json({ 
                        success: false, 
                        message: 'Subdomain must be lowercase alphanumeric with hyphens' 
                    });
                }
                const existingSubdomain = await Tenant.findOne({ subdomain: normalizedSubdomain, tenantId: { $ne: tenantId } });
                if (existingSubdomain) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `Subdomain "${normalizedSubdomain}" is already in use by another tenant` 
                    });
                }
                tenant.subdomain = normalizedSubdomain;
            }
        }
        if (name !== undefined) tenant.name = String(name).trim();
        if (companyName !== undefined) tenant.companyName = String(companyName).trim();
        if (email !== undefined) tenant.email = String(email).trim().toLowerCase();
        if (phone !== undefined) tenant.phone = String(phone).trim();
        if (billingAddress !== undefined) tenant.billingAddress = String(billingAddress).trim();
        if (billingEmail !== undefined) tenant.billingEmail = String(billingEmail).trim().toLowerCase();
        if (billingAmount !== undefined) tenant.billingAmount = billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null;
        if (billingCycle !== undefined) tenant.billingCycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
        if (currency !== undefined) tenant.currency = String(currency).trim() || 'GBP';
        if (status !== undefined && ['active', 'suspended'].includes(status)) tenant.status = status;
        await tenant.save();
    }
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_TENANT_UPDATED',
        entityType: 'Tenant',
        entityId: tenantId,
        success: true,
        message: `Tenant details updated: ${tenantId}`,
        metaJson: { tenantId }
    });
    await invalidatePlatformTenantsCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: tenant, message: 'Tenant updated' });
});

/** Delete a tenant: removes Tenant and TenantSubscription. Tenant-scoped data (users, sales, etc.) remains in DB. */
exports.deleteTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    if (!tenantId || tenantId.trim() === '') {
        return res.status(400).json({ success: false, message: 'Tenant ID is required' });
    }
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
        await TenantSubscription.deleteOne({ tenantId });
        await invalidatePlatformTenantsCache(getTenantIdFromReq(req));
        return res.status(200).json({ success: true, message: 'Tenant removed (subscription cleared)' });
    }
    await TenantSubscription.deleteOne({ tenantId });
    await tenant.deleteOne();
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_TENANT_DELETED',
        entityType: 'Tenant',
        entityId: tenantId,
        success: true,
        message: `Tenant deleted: ${tenantId}`,
        metaJson: { tenantId, name: tenant.name }
    });
    await invalidatePlatformTenantsCache(getTenantIdFromReq(req));
    res.status(200).json({ success: true, message: 'Tenant deleted' });
});

/** List all roles (for platform tenant user create/edit; roles are global in DB) */
exports.listRoles = asyncHandler(async (req, res) => {
    const roles = await Role.find().sort('name').select('name description').lean();
    res.status(200).json({ success: true, data: roles });
});

/** List users for a tenant (platform admin only; for account management) */
exports.listTenantUsers = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId }).select('tenantId').lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const users = await User.find({ tenantId })
        .populate('roles', 'name description')
        .select('-password')
        .sort('-createdAt')
        .lean();
    const data = users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        roles: u.roles,
        isActive: u.isActive,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt
    }));
    res.status(200).json({ success: true, data });
});

/** Create user for a tenant (e.g. admin when client forgets; platform only) */
exports.createTenantUser = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { name, email, password, roleIds, isActive, phone, assignAllRoles } = req.body || {};
    const tenant = await Tenant.findOne({ tenantId }).select('tenantId').lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail) return res.status(400).json({ success: false, message: 'Email is required' });
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) return res.status(400).json({ success: false, message: pwdCheck.message });
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });
    let roleObjectIds = toObjectIds(roleIds);
    if (assignAllRoles === true) {
        const allRoles = await Role.find().select('_id').lean();
        roleObjectIds = allRoles.map((r) => r._id);
    }
    const user = await User.create({
        name: (name || '').trim() || normalizedEmail.split('@')[0],
        email: normalizedEmail,
        password: password,
        roles: roleObjectIds.length ? roleObjectIds : undefined,
        isActive: isActive !== false,
        phone: (phone || '').trim(),
        tenantId
    });
    const saved = await User.findById(user._id).populate('roles', 'name').select('-password').lean();
    await activityLogService.logFromReq(req, {
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `Platform created user for tenant ${tenantId}: ${user.email}`,
        metaJson: { tenantId }
    });
    res.status(201).json({ success: true, data: saved, message: 'User created' });
});

/** Update tenant user (platform only) */
exports.updateTenantUser = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const { name, email, roleIds, isActive, phone } = req.body || {};
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (name !== undefined) user.name = String(name).trim();
    if (email !== undefined) user.email = String(email).trim().toLowerCase();
    if (phone !== undefined) user.phone = String(phone).trim();
    if (isActive !== undefined) user.isActive = !!isActive;
    if (Array.isArray(roleIds)) user.roles = toObjectIds(roleIds);
    await user.save();
    const after = await User.findById(user._id).populate('roles', 'name').select('-password').lean();
    await activityLogService.logFromReq(req, {
        action: 'USER_UPDATED',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `Platform updated user ${user.email} for tenant ${tenantId}`,
        metaJson: { tenantId }
    });
    res.status(200).json({ success: true, data: after, message: 'User updated' });
});

/** Reset password for a tenant user (platform only; when client forgets) */
exports.resetTenantUserPassword = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const { newPassword } = req.body || {};
    const pwdCheck = validatePassword(newPassword);
    if (!pwdCheck.valid) return res.status(400).json({ success: false, message: pwdCheck.message });
    const user = await User.findOne({ _id: userId, tenantId }).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.password = newPassword;
    await user.save();
    await activityLogService.logFromReq(req, {
        action: 'PASSWORD_RESET',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `Platform reset password for ${user.email} (tenant ${tenantId})`,
        metaJson: { tenantId }
    });
    res.status(200).json({ success: true, message: 'Password reset successfully' });
});

/** Delete tenant user (platform only; e.g. remove admin when requested) */
exports.deleteTenantUser = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await user.deleteOne();
    await activityLogService.logFromReq(req, {
        action: 'USER_DELETED',
        entityType: 'User',
        entityId: userId,
        success: true,
        message: `Platform deleted user ${user.email} for tenant ${tenantId}`,
        metaJson: { tenantId }
    });
    res.status(200).json({ success: true, message: 'User deleted' });
});

/** Get subscription for a tenant + effective entitlements + usage */
exports.getSubscription = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const sub = await TenantSubscription.findOne({ tenantId }).lean();
    const [entitlements, usage] = await Promise.all([
        entitlementsService.getEntitlements(tenantId),
        entitlementsService.getUsage(tenantId)
    ]);
    res.status(200).json({
        success: true,
        data: {
            tenantId,
            planKey: sub ? sub.planKey : null,
            startDate: sub?.startDate ?? null,
            expireDate: sub?.expireDate ?? null,
            overrides: sub ? { features: mapToObject(sub.overrides?.features), limits: mapToObject(sub.overrides?.limits) } : { features: {}, limits: {} },
            effective: {
                enabledFeatures: entitlements.enabledFeatures,
                limits: entitlements.limits
            },
            usage
        }
    });
});

/** Update subscription (planKey + overrides + startDate + expireDate) */
exports.updateSubscription = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { planKey, overrides, startDate, expireDate } = req.body;
    let sub = await TenantSubscription.findOne({ tenantId });
    const before = sub ? sub.toObject() : null;
    if (!sub) {
        const now = new Date();
        sub = await TenantSubscription.create({
            tenantId,
            planKey: (planKey || 'starter').trim().toLowerCase(),
            overrides: {
                features: (overrides && overrides.features) || {},
                limits: (overrides && overrides.limits) || {}
            },
            startDate: startDate ? new Date(startDate) : now,
            expireDate: expireDate ? new Date(expireDate) : null
        });
    } else {
        if (planKey !== undefined) sub.planKey = (planKey || 'starter').trim().toLowerCase();
        if (overrides && typeof overrides.features === 'object') sub.overrides.features = overrides.features;
        if (overrides && typeof overrides.limits === 'object') sub.overrides.limits = overrides.limits;
        if (startDate !== undefined) sub.startDate = startDate ? new Date(startDate) : null;
        if (expireDate !== undefined) sub.expireDate = expireDate ? new Date(expireDate) : null;
        await sub.save();
    }
    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_ENTITLEMENTS_UPDATED',
        entityType: 'TenantSubscription',
        entityId: sub._id,
        success: true,
        message: `Subscription updated for tenant ${tenantId}`,
        beforeJson: before,
        afterJson: sub.toObject(),
        metaJson: { tenantId }
    });
    await invalidatePlatformTenantsCache(getTenantIdFromReq(req));
    const [entitlements, usage] = await Promise.all([
        entitlementsService.getEntitlements(tenantId),
        entitlementsService.getUsage(tenantId)
    ]);
    res.status(200).json({
        success: true,
        data: {
            tenantId,
            planKey: sub.planKey,
            startDate: sub.startDate ?? null,
            expireDate: sub.expireDate ?? null,
            overrides: { features: mapToObject(sub.overrides.features), limits: mapToObject(sub.overrides.limits) },
            effective: { enabledFeatures: entitlements.enabledFeatures, limits: entitlements.limits },
            usage
        }
    });
});
