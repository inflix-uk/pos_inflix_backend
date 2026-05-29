/**
 * RBAC: permission checks. Backend is source of truth.
 * can(user, permissionKey) -> boolean. Default deny.
 * Permission keys are cached in memory (per userId) so we only hit the DB on login / first request or after TTL.
 * When user has legacy role 'admin', they get all permissions below without needing seed:rbac.
 */

const User = require('../models/User');

/** All permission keys (must match seedPermissions.js). Used so admin has full access without seeding. */
const ALL_PERMISSION_KEYS = [
    'dashboard.view',
    'sale.view', 'sale.create', 'sale.edit', 'sale.void', 'sale.delete',
    'return.create', 'refund.issue', 'storecredit.grant',
    'product.view', 'product.create', 'product.edit', 'product.delete', 'variant_attribute.create',
    'stock.view', 'inventory.settings.manage', 'stock.adjust', 'stock.receive',
    'parcel.create', 'parcel.status_change',
    'report.view', 'report.export',
    'user.manage', 'role.manage', 'audit.view', 'audit.export',
    'customer.view', 'customer.create', 'customer.edit',
    'accounts.view', 'accounts.payment',
    'purchase.view', 'purchase.create', 'purchase.edit', 'purchase.return',
    'settings.view', 'settings.edit', 'settings.manage', 'settings.printing', 'settings.sales_mode',
    'repair.view', 'repair.create', 'repair.edit', 'repair.delete',
    'expense_category.view', 'expense_category.manage',
    'expense.view', 'expense.create', 'expense.edit_draft', 'expense.submit',
    'expense.approve', 'expense.mark_paid', 'expense.void', 'expense.delete', 'expense.export',
    'stock_transfer.view', 'stock_transfer.create', 'stock_transfer.dispatch', 'stock_transfer.receive', 'stock_transfer.cancel',
    'stock_adjustment.view', 'stock_adjustment.create', 'stock_adjustment.edit_draft', 'stock_adjustment.post', 'stock_adjustment.cancel', 'stock_adjustment.override_missing_cost',
    'inventory.print_labels'
];

/** Legacy users with role string but empty roles[] — still need till printing setup. */
const LEGACY_TILL_ROLES = new Set(['staff', 'cashier', 'manager', 'warehouse']);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const permissionCache = new Map(); // userId -> { keys: Set, role: string, roles: Array, expiresAt: number }

function getCached(userId) {
    const key = String(userId);
    const entry = permissionCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry;
}

function invalidateAllPermissionCaches() {
    permissionCache.clear();
}

function invalidateUserPermissionCache(userId) {
    if (userId) permissionCache.delete(String(userId));
}

function setCached(userId, keys, role, roles) {
    permissionCache.set(String(userId), {
        keys,
        role: role || '',
        roles: roles || [],
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
}

/**
 * Get all permission keys and role for a user (from assigned roles). Used on cache miss only.
 * When user has no roles array but has legacy role 'admin', grant all permissions so platform-created admins work.
 * @param {Object} user - User doc or user id
 * @returns {Promise<{ keys: Set<string>, role: string }>}
 */
async function getPermissionKeysForUser(user) {
    if (!user) return { keys: new Set(), role: '' };
    const userId = user._id || user.id;
    if (!userId) return { keys: new Set(), role: '' };

    const u = await User.findById(userId)
        .populate({ 
            path: 'roles', 
            populate: [
                { path: 'permissions' },
                { path: 'assignedLocationIds', select: '_id name' }
            ]
        })
        .lean();
    if (!u) return { keys: new Set(), role: '' };

    const keys = new Set();
    if (u.roles && u.roles.length > 0) {
        for (const role of u.roles) {
            const perms = role.permissions || [];
            for (const p of perms) {
                const key = typeof p === 'object' && p.key ? p.key : null;
                if (key) keys.add(key);
            }
        }
        const roleName = (u.roles[0] && u.roles[0].name) ? String(u.roles[0].name).toLowerCase() : '';
        return { keys, role: roleName };
    }

    // No roles assigned: preserve legacy role. For admin, grant all permissions so /settings/admin works without seeding.
    const legacyRole = String(u.role || '').toLowerCase();
    if (legacyRole === 'admin') {
        ALL_PERMISSION_KEYS.forEach((k) => keys.add(k));
        return { keys, role: 'admin' };
    }
    return { keys, role: legacyRole };
}

/**
 * Check if user has permission. Default deny.
 * @param {Object} user - User doc (may have .permissionKeys Set attached by middleware)
 * @param {string} permissionKey - e.g. 'refund.issue'
 * @returns {boolean}
 */
function can(user, permissionKey) {
    if (!user || !permissionKey) return false;
    if (user.permissionKeys && user.permissionKeys instanceof Set) {
        return user.permissionKeys.has(permissionKey);
    }
    return false;
}

/**
 * Attach permissionKeys Set (and role) to user. Uses in-memory cache so the heavy RBAC query runs only on first request or after TTL.
 * Also populates user.roles with assignedLocationIds for role-based location access.
 * @param {Object} user - req.user (must have _id)
 */
async function attachPermissionKeys(user) {
    if (!user) return;
    const userId = user._id || user.id;
    if (!userId) return;

    const cached = getCached(userId);
    if (cached) {
        // Cache hit: zero DB queries — roles are cached alongside permissions
        user.permissionKeys = cached.keys;
        user.role = cached.role;
        user.roles = cached.roles;
        return;
    }

    // Cache miss: single DB query with nested populate (gets permissions + roles + locations)
    const u = await User.findById(userId)
        .populate({
            path: 'roles',
            populate: [
                { path: 'permissions' },
                { path: 'assignedLocationIds', select: '_id name' }
            ]
        })
        .lean();

    const keys = new Set();
    let role = '';
    let roles = [];

    if (u && u.roles && u.roles.length > 0) {
        roles = u.roles;
        for (const r of u.roles) {
            const perms = r.permissions || [];
            for (const p of perms) {
                const key = typeof p === 'object' && p.key ? p.key : null;
                if (key) keys.add(key);
            }
        }
        role = (u.roles[0] && u.roles[0].name) ? String(u.roles[0].name).toLowerCase() : '';
    } else if (u) {
        const legacyRole = String(u.role || '').toLowerCase();
        if (legacyRole === 'admin') {
            ALL_PERMISSION_KEYS.forEach((k) => keys.add(k));
        } else if (LEGACY_TILL_ROLES.has(legacyRole)) {
            keys.add('settings.printing');
            keys.add('settings.sales_mode');
        }
        role = legacyRole;
    }

    // All RBAC roles: printing + personal sales mode granted to every role in DB; enforce if seed lagged.
    if (roles.length > 0) {
        keys.add('settings.printing');
        keys.add('settings.sales_mode');
    }

    setCached(userId, keys, role, roles);
    user.permissionKeys = keys;
    user.role = role;
    user.roles = roles;
}

/**
 * Check if user has any of the given roles by name (for legacy compatibility).
 * Use when migrating from role names to permissions gradually.
 */
function hasAnyRole(user, ...roleNames) {
    if (!user) return false;
    const names = roleNames.map((r) => r.toLowerCase());
    const userRole = (user.role || '').toLowerCase();
    if (names.includes(userRole)) return true;
    if (user.roles && Array.isArray(user.roles)) {
        for (const r of user.roles) {
            const name = (r && r.name || '').toLowerCase();
            if (names.includes(name)) return true;
        }
    }
    return false;
}

function invalidateUserCache(userId) {
    if (userId == null) return;
    permissionCache.delete(String(userId));
}

function invalidateAllCache() {
    permissionCache.clear();
}

module.exports = {
    getPermissionKeysForUser,
    can,
    attachPermissionKeys,
    hasAnyRole,
    invalidateAllPermissionCaches,
    invalidateUserPermissionCache
};
