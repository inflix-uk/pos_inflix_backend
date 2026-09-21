/**
 * Create (or reset) an Inflix admin user for any tenant.
 *
 * Generalises scripts/create-admin-techvox.js and scripts/create-admin-tbm.js, which
 * hardcode a single tenant each. Uses the same path the Platform Console uses:
 * bootstrap RBAC (permissions + roles), then attach ALL roles to the user.
 *
 * No locations are assigned: role 'admin' bypasses location scoping (middleware/auth.js),
 * and User.locations empty means "all locations".
 *
 * Usage:
 *   TENANT_ID=fonewarehouse ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<strong-password>' \
 *     node scripts/create-tenant-admin.js                 # dry-run, shows what it would do
 *
 *   ... same env ... node scripts/create-tenant-admin.js --apply
 *
 * If the email already exists in that tenant, --apply resets its password, re-attaches
 * every role and reactivates it. Existing users are otherwise untouched.
 */
const mongoose = require('mongoose');
require('dotenv').config({ path: '.env' });

const { runBootstrapTenantSeeds, modelOnConnection } = require('../src/seeders/bootstrapTenantSeeds');
const UserModel = require('../src/models/User');
const RoleModel = require('../src/models/Role');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID;
const EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const NAME = process.env.ADMIN_NAME || 'Inflix Admin';

const line = (t) => console.log(t);
const head = (t) => console.log('\n' + '-'.repeat(66) + '\n' + t + '\n' + '-'.repeat(66));

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI not set in .env');
        process.exit(1);
    }
    if (!TENANT_ID) {
        console.error('TENANT_ID is required (e.g. TENANT_ID=fonewarehouse)');
        process.exit(1);
    }
    if (!EMAIL || !PASSWORD) {
        console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
        process.exit(1);
    }

    const dbName = (process.env.TENANT_DB_PREFIX || 'tenant_') + TENANT_ID;
    line('Tenant: ' + TENANT_ID + '  (db=' + dbName + ')');
    line('Email:  ' + EMAIL);
    line('Mode:   ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'));

    const conn = await mongoose.createConnection(process.env.MONGODB_URI, { dbName }).asPromise();

    try {
        const User = modelOnConnection(conn, UserModel);
        const Role = modelOnConnection(conn, RoleModel);

        head('CURRENT STATE');
        const existingUsers = await User.find().select('email role isActive').lean();
        line('  users in tenant: ' + existingUsers.length);
        for (const u of existingUsers) line('    ' + u.email + '  role=' + u.role + '  active=' + u.isActive);
        const rolesBefore = await Role.find().select('name').lean();
        line('  roles: ' + (rolesBefore.map((r) => r.name).join(', ') || '(none — will be seeded)'));

        const target = await User.findOne({ email: EMAIL });
        line('  "' + EMAIL + '": ' + (target ? 'EXISTS -> password reset + all roles re-attached' : 'not present -> will be created'));

        if (!APPLY) {
            head('DRY-RUN — nothing written. Re-run with --apply.');
            return;
        }

        head('APPLYING');
        // Idempotent: seeds permissions/roles only if missing.
        await runBootstrapTenantSeeds(conn);
        const allRoles = await Role.find().select('_id name').lean();
        if (!allRoles.length) throw new Error('No roles found after RBAC bootstrap');
        const roleIds = allRoles.map((r) => r._id);
        line('  RBAC ready: ' + allRoles.length + ' roles (' + allRoles.map((r) => r.name).join(', ') + ')');

        let user = await User.findOne({ email: EMAIL });
        if (user) {
            user.name = NAME;
            user.password = PASSWORD; // pre-save hook re-hashes
            user.role = 'admin';
            user.roles = roleIds;
            user.tenantId = TENANT_ID;
            user.isActive = true;
            await user.save();
            line('  updated existing user');
        } else {
            user = await User.create({
                name: NAME,
                email: EMAIL,
                password: PASSWORD, // pre-save hook hashes
                role: 'admin',
                roles: roleIds,
                tenantId: TENANT_ID,
                isActive: true
            });
            line('  created new user');
        }

        head('RESULT');
        line('  id:      ' + user._id);
        line('  name:    ' + user.name);
        line('  email:   ' + user.email);
        line('  role:    ' + user.role + '   roles[]: ' + roleIds.length);
        line('  tenant:  ' + user.tenantId);
        line('  active:  ' + user.isActive);

        // Prove the credential actually works rather than assuming the hash took.
        const check = await User.findOne({ email: EMAIL }).select('+password');
        if (typeof check.matchPassword === 'function') {
            line('  password verifies: ' + (await check.matchPassword(PASSWORD) ? 'YES' : 'NO — investigate'));
        } else if (typeof check.comparePassword === 'function') {
            line('  password verifies: ' + (await check.comparePassword(PASSWORD) ? 'YES' : 'NO — investigate'));
        }
        line('\n  Existing users were not modified. Change this password after first login.');
    } finally {
        await conn.close();
    }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
