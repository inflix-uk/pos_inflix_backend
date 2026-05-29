/**
 * Seed default roles and assign permissions. Idempotent.
 * Migrates existing users (by legacy role) to new Role refs.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PermissionExport = require('../models/Permission');
const RoleExport = require('../models/Role');
const UserExport = require('../models/User');

function roleModelOnConnection(conn) {
    const schema = RoleExport.schema;
    const modelName = RoleExport.modelName;
    return conn.models[modelName] || conn.model(modelName, schema);
}

function userModelOnConnection(conn) {
    const schema = UserExport.schema;
    const modelName = UserExport.modelName;
    return conn.models[modelName] || conn.model(modelName, schema);
}

async function getPermissionIdsByKeys(Permission, keys) {
    const perms = await Permission.find({ key: { $in: keys } }).select('_id').lean();
    return perms.map((p) => p._id);
}

/**
 * @param {import('mongoose').Connection} conn
 * @param {{ migrateUsers?: boolean }} [opts] - Set false when provisioning a new tenant (no users yet).
 */
async function seedRolesOnConnection(conn, opts = {}) {
    const migrateUsers = opts.migrateUsers !== false;
    const Permission = conn.models.Permission || conn.model(PermissionExport.modelName, PermissionExport.schema);
    const Role = roleModelOnConnection(conn);
    const User = userModelOnConnection(conn);

    const allKeys = (await Permission.find().select('key').lean()).map((p) => p.key);
    const adminPermIds = await getPermissionIdsByKeys(Permission, allKeys);

    const managerKeys = allKeys.filter(
        (k) => k !== 'user.manage' && k !== 'role.manage' && k !== 'variant_attribute.create'
    );
    const managerPermIds = await getPermissionIdsByKeys(Permission, managerKeys);

    const staffKeys = [
        'sale.view', 'sale.create', 'return.create', 'product.view', 'stock.view',
        'customer.view', 'customer.create', 'customer.edit', 'parcel.create', 'parcel.status_change',
        'repair.view', 'repair.create', 'repair.edit', 'repair.delete',
        'settings.printing', 'settings.sales_mode'
    ];
    const staffPermIds = await getPermissionIdsByKeys(Permission, staffKeys);

    const cashierKeys = [
        'sale.view', 'sale.create', 'return.create', 'product.view', 'customer.view', 'customer.create', 'customer.edit',
        'settings.printing', 'settings.sales_mode'
    ];
    const cashierPermIds = await getPermissionIdsByKeys(Permission, cashierKeys);

    const warehouseKeys = [
        'product.view', 'stock.view', 'stock.receive', 'stock.adjust', 'parcel.create', 'parcel.status_change',
        'purchase.view', 'purchase.create', 'purchase.edit', 'purchase.return',
        'settings.printing'
    ];
    const warehousePermIds = await getPermissionIdsByKeys(Permission, warehouseKeys);

    const roleDefs = [
        { name: 'Admin', description: 'Full access', permissionIds: adminPermIds },
        { name: 'Manager', description: 'Sales + refunds + reports', permissionIds: managerPermIds },
        { name: 'Staff', description: 'Sales + limited returns', permissionIds: staffPermIds },
        { name: 'Cashier', description: 'Sales only', permissionIds: cashierPermIds },
        { name: 'Warehouse', description: 'Stock + parcels', permissionIds: warehousePermIds }
    ];

    const roleNameToId = {};
    for (const def of roleDefs) {
        const role = await Role.findOneAndUpdate(
            { name: def.name },
            { $set: { description: def.description, permissions: def.permissionIds } },
            { upsert: true, new: true }
        );
        roleNameToId[def.name.toLowerCase()] = role._id;
    }
    if (migrateUsers) {
        console.log('Seeded roles:', Object.keys(roleNameToId));
    }

    // Sync existing users: assign roles[] from legacy role (fixes broken refs after db:clear that wiped roles, or first-time migration)
    if (migrateUsers) {
        const legacyMap = { admin: 'Admin', manager: 'Manager', cashier: 'Cashier', staff: 'Staff', warehouse: 'Warehouse' };
        const validRoleIds = new Set(Object.values(roleNameToId).map((id) => id.toString()));
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
                console.log(`Synced user ${user.email} to role ${roleName}`);
            }
        }
    }

    return { roleNameToId };
}

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('MONGODB_URI required');
        process.exit(1);
    }
    await mongoose.connect(uri);
    await seedRolesOnConnection(mongoose.connection, { migrateUsers: true });
    await mongoose.disconnect();
    console.log('Done');
}

if (require.main === module) {
    run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seedRolesOnConnection, roleModelOnConnection, userModelOnConnection };
