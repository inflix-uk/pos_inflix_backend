/**
 * Run POS tenant DB bootstrap on an existing mongoose Connection (tenant database).
 * Used by platform tenant provisioning and safe to call idempotently.
 */
const { seedPermissionsOnConnection } = require('./seedPermissions');
const { seedExpenseCategoriesOnConnection } = require('./seedExpenseCategories');
const { seedRolesOnConnection } = require('./seedRoles');

function modelOnConnection(conn, ModelExport) {
    const schema = ModelExport.schema;
    const modelName = ModelExport.modelName;
    if (conn.models[modelName]) return conn.models[modelName];
    return conn.model(modelName, schema);
}

async function runBootstrapTenantSeeds(conn) {
    await seedPermissionsOnConnection(conn);
    await seedRolesOnConnection(conn, { migrateUsers: false });
    await seedExpenseCategoriesOnConnection(conn);
}

/**
 * Create the first admin using POS User model (password hashing + roles[]).
 * Call only after runBootstrapTenantSeeds(conn).
 */
async function createFirstTenantAdmin(conn, { email, password, name, tenantId }) {
    const User = modelOnConnection(conn, require('../models/User'));
    const Role = modelOnConnection(conn, require('../models/Role'));
    const adminRole = await Role.findOne({ name: 'Admin' });
    if (!adminRole) {
        throw new Error('Admin role not found after tenant RBAC seed');
    }
    return User.create({
        name,
        email: String(email).trim().toLowerCase(),
        password: String(password),
        role: 'admin',
        roles: [adminRole._id],
        tenantId,
        isActive: true,
    });
}

module.exports = {
    runBootstrapTenantSeeds,
    createFirstTenantAdmin,
    modelOnConnection,
};
