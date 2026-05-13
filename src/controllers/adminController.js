/**
 * Admin RBAC: users, roles, permissions. All actions audited.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const Permission = require('../models/Permission');
const Location = require('../models/Location');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { validatePassword } = require('../utils/passwordPolicy');
const ensureRbacSeeded = require('../services/ensureRbacSeeded');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const ADMIN_RBAC_NAMESPACES = ['admin:roles', 'admin:permissions'];
async function invalidateRbacCaches(tenantId) {
    await cache.bumpMany(ADMIN_RBAC_NAMESPACES, tenantId);
}

function toObjectIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.filter((id) => id && mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * Validate that location IDs belong to the current tenant.
 * @param {string[]} locationIds - Array of location ID strings
 * @param {string} tenantId - Current tenant ID
 * @returns {Promise<{valid: boolean, invalid: string[], message?: string}>}
 */
async function validateLocationsInTenant(locationIds, tenantId) {
    if (!Array.isArray(locationIds) || locationIds.length === 0) {
        return { valid: true, invalid: [] };
    }
    const validIds = locationIds.filter((id) => id && mongoose.isValidObjectId(id));
    if (validIds.length === 0) {
        return { valid: true, invalid: [] };
    }
    const found = await Location.find({ _id: { $in: validIds }, tenantId }).select('_id').lean();
    const foundIds = new Set(found.map((l) => l._id.toString()));
    const invalid = validIds.filter((id) => !foundIds.has(id.toString()));
    if (invalid.length > 0) {
        return {
            valid: false,
            invalid,
            message: `One or more locations do not belong to this tenant: ${invalid.join(', ')}`
        };
    }
    return { valid: true, invalid: [] };
}

// ---------- Users ----------

const { getTenantIdFromReq } = require('../middleware/auth');

exports.listUsers = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);
    const query = { tenantId };
    if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';
    if (req.query.search) {
        query.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { email: { $regex: req.query.search, $options: 'i' } }
        ];
    }
    const total = await User.countDocuments(query);
    const users = await User.find(query)
        .populate('roles', 'name description')
        .select('-password')
        .skip(startIndex)
        .limit(limit)
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
        updatedAt: u.updatedAt,
        assignedLocationIds: u.assignedLocationIds,
        defaultLocationId: u.defaultLocationId
    }));

    res.status(200).json({
        success: true,
        data,
        total,
        page,
        pages: Math.ceil(total / limit)
    });
});

exports.getUser = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId })
        .populate('roles', 'name description')
        .select('-password')
        .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, data: user });
});

exports.createUser = asyncHandler(async (req, res) => {
    // Phase 4: Ignore body.tenantId - always use resolved tenant
    const { name, email, password, roleIds, isActive, phone, assignedLocationIds, defaultLocationId } = req.body;
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) {
        return res.status(400).json({ success: false, message: pwdCheck.message });
    }
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
        return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    const entitlementsService = require('../services/entitlementsService');
    const platformEntitlementsCache = require('../services/platformEntitlementsCache');
    const platformClient = require('../lib/platformClient');
    const tenantId = getTenantIdFromReq(req);
    
    // Phase 4: Validate location assignments
    const locationIds = Array.isArray(assignedLocationIds) ? assignedLocationIds : [];
    if (locationIds.length > 0) {
        const locValidation = await validateLocationsInTenant(locationIds, tenantId);
        if (!locValidation.valid) {
            return res.status(400).json({ success: false, message: locValidation.message });
        }
    }
    
    // Phase 4: Validate defaultLocationId
    if (defaultLocationId) {
        if (!mongoose.isValidObjectId(defaultLocationId)) {
            return res.status(400).json({ success: false, message: 'Invalid defaultLocationId format' });
        }
        // If assignedLocationIds is non-empty, defaultLocationId must be in it
        if (locationIds.length > 0) {
            const defaultIdStr = defaultLocationId.toString();
            if (!locationIds.some((id) => id.toString() === defaultIdStr)) {
                return res.status(400).json({ success: false, message: 'defaultLocationId must be one of assignedLocationIds' });
            }
        }
        // Validate defaultLocationId belongs to tenant
        const defaultLoc = await Location.findOne({ _id: defaultLocationId, tenantId }).select('_id').lean();
        if (!defaultLoc) {
            return res.status(400).json({ success: false, message: 'defaultLocationId does not belong to this tenant' });
        }
    }
    
    let proposedUsers;
    if (platformClient.isPlatformConfigured()) {
        const ent = await platformEntitlementsCache.getEntitlements();
        proposedUsers = (ent.usage?.usersUsed ?? 0) + 1;
    } else {
        proposedUsers = (await User.countDocuments({ tenantId })) + 1;
    }
    try {
        await entitlementsService.assertLimit(tenantId, 'maxUsers', proposedUsers);
    } catch (err) {
        return res.status(err.status || 402).json({ success: false, message: err.message || 'User limit exceeded', code: err.code });
    }
    const roleObjectIds = toObjectIds(roleIds);
    const locationObjectIds = locationIds.length > 0 ? toObjectIds(locationIds) : undefined;
    const defaultLocationObjectId = defaultLocationId && mongoose.isValidObjectId(defaultLocationId) ? new mongoose.Types.ObjectId(defaultLocationId) : undefined;
    
    const user = await User.create({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password,
        roles: roleObjectIds.length ? roleObjectIds : undefined,
        isActive: isActive !== false,
        phone: phone || '',
        tenantId,
        assignedLocationIds: locationObjectIds,
        defaultLocationId: defaultLocationObjectId
    });
    const saved = await User.findById(user._id).populate('roles', 'name').select('-password').lean();
    await activityLogService.logFromReq(req, {
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `User created: ${user.email}`,
        afterJson: saved
    });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    if (platformClient.isPlatformConfigured()) {
        platformClient.postPlatformEvent('USER_CREATED', 1, { userId: user._id?.toString(), email: user.email, actorUserId: req.user?._id?.toString() }).catch((e) => console.error('[adminController] Platform event USER_CREATED failed', e.message));
    }
    res.status(201).json({ success: true, data: saved, message: 'User created' });
});

exports.updateUser = asyncHandler(async (req, res) => {
    // Phase 4: Ignore body.tenantId - never trust frontend for tenant assignment
    const { name, email, roleIds, isActive, phone, assignedLocationIds, defaultLocationId } = req.body;
    const tenantId = getTenantIdFromReq(req);
    
    // Phase 4: Verify user belongs to current tenant
    const user = await User.findOne({ _id: req.params.id, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    const before = user.toObject();
    if (name !== undefined) user.name = name.trim();
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (phone !== undefined) user.phone = phone || '';
    if (isActive !== undefined) user.isActive = !!isActive;
    if (Array.isArray(roleIds)) {
        user.roles = toObjectIds(roleIds);
    }
    
    // Phase 4: Handle location assignments
    if (assignedLocationIds !== undefined) {
        const locationIds = Array.isArray(assignedLocationIds) ? assignedLocationIds : [];
        if (locationIds.length > 0) {
            const locValidation = await validateLocationsInTenant(locationIds, tenantId);
            if (!locValidation.valid) {
                return res.status(400).json({ success: false, message: locValidation.message });
            }
            user.assignedLocationIds = toObjectIds(locationIds);
        } else {
            // Empty array = clear assignments (legacy: all locations)
            user.assignedLocationIds = [];
        }
    }
    
    // Phase 4: Handle defaultLocationId
    if (defaultLocationId !== undefined) {
        if (defaultLocationId === null || defaultLocationId === '') {
            user.defaultLocationId = null;
        } else {
            if (!mongoose.isValidObjectId(defaultLocationId)) {
                return res.status(400).json({ success: false, message: 'Invalid defaultLocationId format' });
            }
            // If assignedLocationIds is non-empty, defaultLocationId must be in it
            const currentAssigned = user.assignedLocationIds || [];
            if (currentAssigned.length > 0) {
                const defaultIdStr = defaultLocationId.toString();
                if (!currentAssigned.some((id) => id.toString() === defaultIdStr)) {
                    return res.status(400).json({ success: false, message: 'defaultLocationId must be one of assignedLocationIds' });
                }
            }
            // Validate defaultLocationId belongs to tenant
            const defaultLoc = await Location.findOne({ _id: defaultLocationId, tenantId }).select('_id').lean();
            if (!defaultLoc) {
                return res.status(400).json({ success: false, message: 'defaultLocationId does not belong to this tenant' });
            }
            user.defaultLocationId = new mongoose.Types.ObjectId(defaultLocationId);
        }
    }
    
    await user.save();
    const after = await User.findById(user._id).populate('roles', 'name').select('-password').lean();
    const action = isActive === false ? 'USER_DISABLED' : 'USER_UPDATED';
    if (isActive === false && before.isActive) await activityLogService.logFromReq(req, { action: 'USER_DISABLED', entityType: 'User', entityId: user._id, success: true, message: `User disabled: ${user.email}`, beforeJson: before, afterJson: after });
    else if (isActive === true && !before.isActive) await activityLogService.logFromReq(req, { action: 'USER_ENABLED', entityType: 'User', entityId: user._id, success: true, message: `User enabled: ${user.email}`, beforeJson: before, afterJson: after });
    else await activityLogService.logFromReq(req, { action: 'USER_UPDATED', entityType: 'User', entityId: user._id, success: true, message: `User updated: ${user.email}`, beforeJson: before, afterJson: after });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: after, message: 'User updated' });
});

exports.resetUserPassword = asyncHandler(async (req, res) => {
    const { newPassword } = req.body;
    const pwdCheck = validatePassword(newPassword);
    if (!pwdCheck.valid) {
        return res.status(400).json({ success: false, message: pwdCheck.message });
    }
    // Phase 4: Verify user belongs to current tenant
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId }).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.password = newPassword;
    await user.save();
    await activityLogService.logFromReq(req, {
        action: 'PASSWORD_RESET',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `Password reset for: ${user.email}`
    });
    res.status(200).json({ success: true, message: 'Password reset successfully' });
});

exports.deleteUser = asyncHandler(async (req, res) => {
    // Phase 4: Verify user belongs to current tenant
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }
    const userIdStr = user._id?.toString();
    const email = user.email;
    await user.deleteOne();
    await activityLogService.logFromReq(req, {
        action: 'USER_DELETED',
        entityType: 'User',
        entityId: user._id,
        success: true,
        message: `User deleted: ${email}`,
        beforeJson: { email, name: user.name }
    });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    const platformClient = require('../lib/platformClient');
    if (platformClient.isPlatformConfigured()) {
        platformClient.postPlatformEvent('USER_DELETED', 1, { userId: userIdStr, actorUserId: req.user?._id?.toString() }).catch((e) => console.error('[adminController] Platform event USER_DELETED failed', e.message));
    }
    res.status(200).json({ success: true, message: 'User deleted' });
});

// ---------- Roles ----------

exports.listRoles = asyncHandler(async (req, res) => {
    await ensureRbacSeeded.ensure();
    const tenantId = getTenantIdFromReq(req);
    const roles = await cache.cached(
        { ns: 'admin:roles', tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => Role.find().populate('assignedLocationIds', 'name type').sort('name').lean()
    );
    res.status(200).json({ success: true, data: roles });
});

exports.getRole = asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id)
        .populate('permissions', 'key description group')
        .populate('assignedLocationIds', 'name type')
        .lean();
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    res.status(200).json({ success: true, data: role });
});

exports.createRole = asyncHandler(async (req, res) => {
    const { name, description, permissionIds, assignedLocationIds } = req.body;
    const existing = await Role.findOne({ name: name.trim() });
    if (existing) return res.status(400).json({ success: false, message: 'Role name already exists' });
    const permIds = toObjectIds(permissionIds || []);
    
    // Phase 4: Handle role location assignments
    const tenantId = getTenantIdFromReq(req);
    let locationObjectIds = undefined;
    if (assignedLocationIds !== undefined) {
        const locationIds = Array.isArray(assignedLocationIds) ? assignedLocationIds : [];
        if (locationIds.length > 0) {
            const locValidation = await validateLocationsInTenant(locationIds, tenantId);
            if (!locValidation.valid) {
                return res.status(400).json({ success: false, message: locValidation.message });
            }
            locationObjectIds = toObjectIds(locationIds);
        } else {
            // Empty array = clear assignments (role does not restrict locations)
            locationObjectIds = [];
        }
    }
    
    const role = await Role.create({ 
        name: name.trim(), 
        description: (description || '').trim(), 
        permissions: permIds,
        assignedLocationIds: locationObjectIds
    });
    await activityLogService.logFromReq(req, { action: 'ROLE_CREATED', entityType: 'Role', entityId: role._id, success: true, message: `Role created: ${role.name}`, afterJson: role.toObject() });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    res.status(201).json({ success: true, data: role, message: 'Role created' });
});

exports.updateRole = asyncHandler(async (req, res) => {
    const { name, description, assignedLocationIds } = req.body;
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    const before = role.toObject();
    if (name !== undefined) role.name = name.trim();
    if (description !== undefined) role.description = description.trim();
    
    // Phase 4: Handle role location assignments
    if (assignedLocationIds !== undefined) {
        const tenantId = getTenantIdFromReq(req);
        const locationIds = Array.isArray(assignedLocationIds) ? assignedLocationIds : [];
        if (locationIds.length > 0) {
            const locValidation = await validateLocationsInTenant(locationIds, tenantId);
            if (!locValidation.valid) {
                return res.status(400).json({ success: false, message: locValidation.message });
            }
            role.assignedLocationIds = toObjectIds(locationIds);
        } else {
            // Empty array = clear assignments (role does not restrict locations)
            role.assignedLocationIds = [];
        }
    }
    
    await role.save();
    await activityLogService.logFromReq(req, { action: 'ROLE_UPDATED', entityType: 'Role', entityId: role._id, success: true, message: `Role updated: ${role.name}`, beforeJson: before, afterJson: role.toObject() });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: role, message: 'Role updated' });
});

exports.deleteRole = asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    const inUse = await User.countDocuments({ roles: role._id });
    if (inUse > 0) {
        return res.status(400).json({ success: false, message: `Cannot delete role: ${inUse} user(s) have this role` });
    }
    const before = role.toObject();
    await role.deleteOne();
    await activityLogService.logFromReq(req, { action: 'ROLE_DELETED', entityType: 'Role', entityId: req.params.id, success: true, message: `Role deleted: ${before.name}`, beforeJson: before });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    res.status(200).json({ success: true, message: 'Role deleted' });
});

exports.getRolePermissions = asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id).select('permissions').populate('permissions', 'key').lean();
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    const keys = (role.permissions || []).map((p) => p.key);
    res.status(200).json({ success: true, data: keys });
});

exports.saveRolePermissions = asyncHandler(async (req, res) => {
    const { permissionKeys } = req.body;
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    const perms = await Permission.find({ key: { $in: permissionKeys || [] } }).select('_id').lean();
    const before = role.permissions.map((p) => p.toString());
    role.permissions = perms.map((p) => p._id);
    await role.save();
    await activityLogService.logFromReq(req, {
        action: 'ROLE_PERMISSIONS_CHANGED',
        entityType: 'Role',
        entityId: role._id,
        success: true,
        message: `Permissions updated for role: ${role.name}`,
        diffJson: { before: before.length, after: role.permissions.length }
    });
    await invalidateRbacCaches(getTenantIdFromReq(req));
    res.status(200).json({ success: true, data: permissionKeys, message: 'Permissions saved' });
});

// ---------- Permissions ----------

exports.listPermissions = asyncHandler(async (req, res) => {
    await ensureRbacSeeded.ensure();
    const tenantId = getTenantIdFromReq(req);
    const permissions = await cache.cached(
        { ns: 'admin:permissions', tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => Permission.find().sort('group key').lean()
    );
    res.status(200).json({ success: true, data: permissions });
});
