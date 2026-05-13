/**
 * Create the Inflix Admin user for tenant_techvox.
 * Bootstraps RBAC (permissions + roles) and assigns ALL roles to the user
 * — same path the Platform Console uses (assignAllRoles=true).
 *
 * Run: node scripts/create-admin-techvox.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: '.env' });

const { runBootstrapTenantSeeds, modelOnConnection } = require('../src/seeders/bootstrapTenantSeeds');
const UserModel = require('../src/models/User');
const RoleModel = require('../src/models/Role');

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI not set in .env');
        process.exit(1);
    }

    const tenantId = 'techvox';
    const dbName = (process.env.TENANT_DB_PREFIX || 'tenant_') + tenantId;
    const email = 'admin@inflix.uk';
    const password = 'Admin@12345';
    const name = 'Inflix Admin';

    console.log(`Connecting to MongoDB (db: ${dbName})...`);
    const conn = await mongoose.createConnection(process.env.MONGODB_URI, { dbName }).asPromise();
    console.log('Connected\n');

    try {
        console.log('Bootstrapping RBAC (permissions + roles)...');
        await runBootstrapTenantSeeds(conn);
        console.log('  RBAC seeded\n');

        const User = modelOnConnection(conn, UserModel);
        const Role = modelOnConnection(conn, RoleModel);

        const allRoles = await Role.find().select('_id name').lean();
        if (!allRoles.length) throw new Error('No roles found after RBAC bootstrap');
        const roleIds = allRoles.map(r => r._id);
        console.log(`Found ${allRoles.length} roles: ${allRoles.map(r => r.name).join(', ')}\n`);

        const normalizedEmail = email.toLowerCase().trim();
        const existing = await User.findOne({ email: normalizedEmail });

        if (existing) {
            existing.name = name;
            existing.password = password; // pre-save hook re-hashes
            existing.role = 'admin';
            existing.roles = roleIds;
            existing.tenantId = tenantId;
            existing.isActive = true;
            await existing.save();

            console.log('Admin user updated:');
            console.log('--------------------------------');
            console.log(`   ID:       ${existing._id}`);
            console.log(`   Email:    ${existing.email}`);
            console.log(`   Password: ${password}  (re-hashed)`);
            console.log(`   Role:     ${existing.role}`);
            console.log(`   Roles[]:  ${allRoles.length} roles attached`);
            console.log(`   Tenant:   ${existing.tenantId}`);
            console.log('--------------------------------');
            return;
        }

        const user = await User.create({
            name,
            email: normalizedEmail,
            password,
            role: 'admin',
            roles: roleIds,
            tenantId,
            isActive: true,
        });

        console.log('Admin user created successfully!');
        console.log('--------------------------------');
        console.log(`   ID:       ${user._id}`);
        console.log(`   Name:     ${user.name}`);
        console.log(`   Email:    ${user.email}`);
        console.log(`   Password: ${password}`);
        console.log(`   Role:     ${user.role}`);
        console.log(`   Roles[]:  ${allRoles.length} roles attached (${allRoles.map(r => r.name).join(', ')})`);
        console.log(`   Tenant:   ${user.tenantId}`);
        console.log('--------------------------------');
    } catch (err) {
        console.error('Error:', err.message);
        if (err.code === 11000) console.error('   (Email already exists with different tenant)');
        throw err;
    } finally {
        await conn.close();
    }
}

run()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
