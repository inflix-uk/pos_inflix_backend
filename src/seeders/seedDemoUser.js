/**
 * Create demo login credentials for testing/demo.
 * - Tenant app (main login at /): demo@inflix.co.uk / Demo123!
 * - Platform console (/platform-login): demo-platform@inflix.co.uk / Demo123!
 *
 * Usage: node src/seeders/seedDemoUser.js
 * Uses MONGODB_URI and TENANT_ID from .env (must match backend tenant DB).
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const User = require('../models/User');
const PlatformUser = require('../models/PlatformUser');
const Tenant = require('../models/Tenant');
const TenantSubscription = require('../models/TenantSubscription');

const DEMO_TENANT_EMAIL = 'demo@inflix.co.uk';
const DEMO_TENANT_PASSWORD = 'Demo123!';
const DEMO_PLATFORM_EMAIL = 'demo-platform@inflix.co.uk';
const DEMO_PLATFORM_PASSWORD = 'Demo123!';
const TENANT_ID = process.env.TENANT_ID || config.tenantId || 'default';
const TENANT_DB = (config.tenantDbPrefix || 'tenant_') + TENANT_ID;

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is required in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const tenantDb = mongoose.connection.useDb(TENANT_DB, { useCache: true });
    console.log('Connected to MongoDB');
    console.log('Tenant database:', TENANT_DB, '(TENANT_ID=' + TENANT_ID + ')');

    await tenantContext.run({ tenantDb, tenantId: TENANT_ID }, async () => {
        let tenant = await Tenant.findOne({ tenantId: TENANT_ID });
        if (!tenant) {
            await Tenant.create({
                tenantId: TENANT_ID,
                name: 'Demo Tenant',
                companyName: 'Demo',
                email: DEMO_TENANT_EMAIL,
                status: 'active',
            });
            console.log('Created Tenant:', TENANT_ID);
        }
        let sub = await TenantSubscription.findOne({ tenantId: TENANT_ID });
        if (!sub) {
            await TenantSubscription.create({
                tenantId: TENANT_ID,
                planKey: 'starter',
                startDate: new Date(),
            });
            console.log('Created TenantSubscription for', TENANT_ID);
        }

        let tenantUser = await User.findOne({ email: DEMO_TENANT_EMAIL });
        if (tenantUser) {
            tenantUser.password = DEMO_TENANT_PASSWORD;
            tenantUser.role = 'admin';
            tenantUser.isActive = true;
            tenantUser.tenantId = TENANT_ID;
            await tenantUser.save();
            console.log('Updated tenant demo user:', DEMO_TENANT_EMAIL);
        } else {
            await User.create({
                name: 'Demo User',
                email: DEMO_TENANT_EMAIL,
                password: DEMO_TENANT_PASSWORD,
                role: 'admin',
                tenantId: TENANT_ID,
                isActive: true,
            });
            console.log('Created tenant demo user:', DEMO_TENANT_EMAIL);
        }

        const bcrypt = require('bcryptjs');
        const salt = await bcrypt.genSalt(config.bcryptSaltRounds || 10);
        const platformHash = await bcrypt.hash(DEMO_PLATFORM_PASSWORD, salt);

        let platformUser = await PlatformUser.findOne({ email: DEMO_PLATFORM_EMAIL });
        if (platformUser) {
            platformUser.passwordHash = platformHash;
            platformUser.isActive = true;
            await platformUser.save();
            console.log('Updated platform demo user:', DEMO_PLATFORM_EMAIL);
        } else {
            await PlatformUser.create({
                email: DEMO_PLATFORM_EMAIL,
                passwordHash: platformHash,
                role: 'platform_admin',
                isActive: true,
            });
            console.log('Created platform demo user:', DEMO_PLATFORM_EMAIL);
        }
    });

    console.log('\n--- Demo credentials ---');
    console.log('Tenant app (main login):');
    console.log('  Email:', DEMO_TENANT_EMAIL);
    console.log('  Password:', DEMO_TENANT_PASSWORD);
    console.log('  Database:', TENANT_DB);
    console.log('\nPlatform console (/platform-login):');
    console.log('  Email:', DEMO_PLATFORM_EMAIL);
    console.log('  Password:', DEMO_PLATFORM_PASSWORD);
    console.log('---\n');

    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
