/**
 * Ensures permissions and default roles exist when Admin UI is used.
 * Idempotent: safe to call on every listRoles / listPermissions.
 * So admins see Roles & Permissions without running seed:rbac manually.
 */

const Permission = require('../models/Permission');
const Role = require('../models/Role');
const User = require('../models/User');

const PERMISSIONS = [
    { key: 'dashboard.view', description: 'View main dashboard (/dashboard)', group: 'Dashboard' },
    { key: 'sale.view', description: 'View sales', group: 'Sales' },
    { key: 'sale.create', description: 'Create a sale', group: 'Sales' },
    { key: 'sale.edit', description: 'Edit sale (restricted)', group: 'Sales' },
    { key: 'sale.void', description: 'Void invoice', group: 'Sales' },
    { key: 'sale.delete', description: 'Permanently delete sale (admin only)', group: 'Sales' },
    { key: 'invoice.view', description: 'View invoices', group: 'Invoices' },
    { key: 'invoice.create', description: 'Create an invoice', group: 'Invoices' },
    { key: 'invoice.edit', description: 'Edit invoice', group: 'Invoices' },
    { key: 'invoice.void', description: 'Void invoice', group: 'Invoices' },
    { key: 'invoice.delete', description: 'Permanently delete invoice (admin only)', group: 'Invoices' },
    { key: 'return.create', description: 'Create return', group: 'Returns & Refunds' },
    { key: 'refund.issue', description: 'Issue refund', group: 'Returns & Refunds' },
    { key: 'storecredit.grant', description: 'Grant store credit', group: 'Returns & Refunds' },
    { key: 'product.view', description: 'View products', group: 'Products' },
    { key: 'product.create', description: 'Create products', group: 'Products' },
    { key: 'product.edit', description: 'Edit products', group: 'Products' },
    { key: 'product.delete', description: 'Delete products', group: 'Products' },
    { key: 'stock.view', description: 'View stock', group: 'Inventory' },
    { key: 'inventory.settings.manage', description: 'Manage inventory settings (e.g. default low stock threshold)', group: 'Inventory' },
    { key: 'stock.adjust', description: 'Adjust stock', group: 'Inventory' },
    { key: 'stock.receive', description: 'Receive stock', group: 'Inventory' },
    { key: 'parcel.create', description: 'Create parcel', group: 'Parcels' },
    { key: 'parcel.status_change', description: 'Change parcel status', group: 'Parcels' },
    { key: 'report.view', description: 'View reports', group: 'Reports' },
    { key: 'report.export', description: 'Export reports', group: 'Reports' },
    { key: 'report.zread', description: 'View Daily Closing Till Reading (Z-Read) dashboard', group: 'Reports' },
    { key: 'user.manage', description: 'Manage users', group: 'Admin' },
    { key: 'role.manage', description: 'Manage roles', group: 'Admin' },
    { key: 'audit.view', description: 'View activity log', group: 'Admin' },
    { key: 'audit.export', description: 'Export activity log', group: 'Admin' },
    { key: 'customer.view', description: 'View customers', group: 'Customers' },
    { key: 'customer.create', description: 'Create customers', group: 'Customers' },
    { key: 'customer.edit', description: 'Edit customers', group: 'Customers' },
    { key: 'accounts.view', description: 'View accounts / statements', group: 'Accounts' },
    { key: 'accounts.payment', description: 'Record payments', group: 'Accounts' },
    { key: 'purchase.view', description: 'View purchases', group: 'Purchases' },
    { key: 'purchase.create', description: 'Create purchases', group: 'Purchases' },
    { key: 'purchase.edit', description: 'Edit purchases', group: 'Purchases' },
    { key: 'purchase.return', description: 'Return purchases to supplier', group: 'Purchases' },
    { key: 'settings.view', description: 'View settings', group: 'Settings' },
    { key: 'settings.edit', description: 'Edit settings', group: 'Settings' },
    { key: 'settings.manage', description: 'Manage company-wide settings (e.g. sales default account)', group: 'Settings' },
    { key: 'settings.printing', description: 'Configure silent printing on this device (Print Bridge, printers)', group: 'Settings' },
    { key: 'repair.view', description: 'View repairs', group: 'Repairs' },
    { key: 'repair.create', description: 'Create repair', group: 'Repairs' },
    { key: 'repair.edit', description: 'Edit repair', group: 'Repairs' },
    { key: 'repair.delete', description: 'Delete repair', group: 'Repairs' },
    { key: 'expense_category.view', description: 'View expense categories', group: 'Expenses' },
    { key: 'expense_category.manage', description: 'Manage expense categories', group: 'Expenses' },
    { key: 'expense.view', description: 'View expenses', group: 'Expenses' },
    { key: 'expense.create', description: 'Create expense', group: 'Expenses' },
    { key: 'expense.edit_draft', description: 'Edit draft/submitted expense', group: 'Expenses' },
    { key: 'expense.submit', description: 'Submit expense', group: 'Expenses' },
    { key: 'expense.approve', description: 'Approve/reject expense', group: 'Expenses' },
    { key: 'expense.mark_paid', description: 'Mark expense as paid', group: 'Expenses' },
    { key: 'expense.void', description: 'Void expense', group: 'Expenses' },
    { key: 'expense.delete', description: 'Delete draft/submitted expense', group: 'Expenses' },
    { key: 'expense.export', description: 'Export expenses', group: 'Expenses' },
    { key: 'stock_transfer.view', description: 'View stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.create', description: 'Create and edit draft stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.dispatch', description: 'Dispatch stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.receive', description: 'Receive stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.cancel', description: 'Cancel draft stock transfers', group: 'Stock Transfers' },
    { key: 'stock_adjustment.view', description: 'View stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.create', description: 'Create draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.edit_draft', description: 'Edit draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.post', description: 'Post stock adjustments (create ledger entries)', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.cancel', description: 'Cancel draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.override_missing_cost', description: 'Post adjustment when cost is missing (manager)', group: 'Stock Adjustments' },
    { key: 'inventory.print_labels', description: 'Print QR/labels (products, serials, locations)', group: 'Inventory' }
];

/**
 * Upsert all permissions in the catalog.
 * Returns true if any permission was newly inserted (caller can invalidate caches).
 */
async function ensurePermissions() {
    // Check which catalog keys are missing before upserting, so we can report whether
    // anything actually got inserted (Mongoose 8 dropped rawResult; this is portable).
    const catalogKeys = PERMISSIONS.map((p) => p.key);
    const existing = await Permission.find({ key: { $in: catalogKeys } }).select('key').lean();
    const existingKeys = new Set(existing.map((p) => p.key));
    const willInsert = catalogKeys.some((k) => !existingKeys.has(k));

    // Parallel upserts — sequential awaits used to dominate Admin page load time over a slow DB.
    await Promise.all(
        PERMISSIONS.map((p) =>
            Permission.findOneAndUpdate(
                { key: p.key },
                { $set: { description: p.description, group: p.group } },
                { upsert: true }
            )
        )
    );
    return willInsert;
}

async function getPermissionIdsByKeys(keys) {
    const perms = await Permission.find({ key: { $in: keys } }).select('_id').lean();
    return perms.map((p) => p._id);
}

/** Grant settings.printing to every role (default + custom). Idempotent. */
async function ensurePrintingPermissionOnRoles() {
    const perm = await Permission.findOne({ key: 'settings.printing' }).select('_id').lean();
    if (!perm) return;
    const result = await Role.updateMany(
        {},
        { $addToSet: { permissions: perm._id } }
    );
    if (result.modifiedCount > 0) {
        const { invalidateAllPermissionCaches } = require('./rbacService');
        invalidateAllPermissionCaches();
    }
}

async function ensureRoles() {
    const count = await Role.countDocuments();
    if (count > 0) return;

    const allKeys = PERMISSIONS.map((p) => p.key);
    const adminPermIds = await getPermissionIdsByKeys(allKeys);
    const managerKeys = allKeys.filter((k) => k !== 'user.manage' && k !== 'role.manage');
    const managerPermIds = await getPermissionIdsByKeys(managerKeys);
    const staffKeys = [
        'sale.view', 'sale.create', 'return.create', 'product.view', 'stock.view',
        'customer.view', 'customer.create', 'customer.edit', 'parcel.create', 'parcel.status_change',
        'repair.view', 'repair.create', 'repair.edit', 'repair.delete',
        'settings.printing'
    ];
    const staffPermIds = await getPermissionIdsByKeys(staffKeys);
    const cashierKeys = [
        'sale.view', 'sale.create', 'return.create', 'product.view', 'customer.view', 'customer.create', 'customer.edit',
        'settings.printing'
    ];
    const cashierPermIds = await getPermissionIdsByKeys(cashierKeys);
    const warehouseKeys = [
        'product.view', 'stock.view', 'stock.receive', 'stock.adjust', 'parcel.create', 'parcel.status_change',
        'purchase.view', 'purchase.create', 'purchase.edit', 'purchase.return',
        'settings.printing'
    ];
    const warehousePermIds = await getPermissionIdsByKeys(warehouseKeys);

    const roleDefs = [
        { name: 'Admin', description: 'Full access', permissionIds: adminPermIds },
        { name: 'Manager', description: 'Sales + refunds + reports', permissionIds: managerPermIds },
        { name: 'Staff', description: 'Sales + limited returns', permissionIds: staffPermIds },
        { name: 'Cashier', description: 'Sales only', permissionIds: cashierPermIds },
        { name: 'Warehouse', description: 'Stock + parcels', permissionIds: warehousePermIds }
    ];

    for (const def of roleDefs) {
        await Role.findOneAndUpdate(
            { name: def.name },
            { $set: { description: def.description, permissions: def.permissionIds } },
            { upsert: true }
        );
    }

    // Sync existing users: assign roles[] from legacy role so admin users get Admin role
    const roleNameToId = {};
    const roles = await Role.find().lean();
    for (const r of roles) {
        roleNameToId[r.name.toLowerCase()] = r._id;
    }
    const legacyMap = { admin: 'Admin', manager: 'Manager', cashier: 'Cashier', staff: 'Staff', warehouse: 'Warehouse' };
    const validRoleIds = new Set(roles.map((r) => r._id.toString()));
    const users = await User.find({});
    for (const user of users) {
        const legacyRole = (user.role || 'cashier').toLowerCase();
        const roleName = legacyMap[legacyRole] || 'Cashier';
        const roleId = roleNameToId[roleName.toLowerCase()];
        if (!roleId) continue;
        const currentRoleId = user.roles && user.roles[0];
        const needsUpdate = !currentRoleId || !validRoleIds.has(String(currentRoleId));
        if (needsUpdate) {
            user.roles = [roleId];
            await user.save();
        }
    }
}

// Process-level memoisation. The seed is idempotent and the catalog is fixed at boot,
// so re-running it on every Admin API call wastes ~130 DB roundtrips per page load.
let ensurePromise = null;

/**
 * Ensures permissions and default roles exist. Call before listRoles or listPermissions.
 * Memoised per process so repeated calls are free; on failure the next call will retry.
 */
function ensure() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        const inserted = await ensurePermissions();
        await ensureRoles();
        await ensurePrintingPermissionOnRoles();
        return { permissionsInserted: inserted };
    })().catch((err) => {
        ensurePromise = null;
        throw err;
    });
    return ensurePromise;
}

module.exports = { ensure, ensurePermissions, ensureRoles, ensurePrintingPermissionOnRoles, PERMISSIONS };
