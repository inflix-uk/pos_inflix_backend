/**
 * Create admin user for tenant from TENANT_ID env var.
 * Run: node scripts/create-admin-tbm.js
 */

const mongoose = require('mongoose');
const User = require('../src/models/User');
require('dotenv').config({ path: '.env' });

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI not set in .env');
        process.exit(1);
    }

    const tenantId = process.env.TENANT_ID || 'default';
    const email = (process.env.ADMIN_EMAIL || 'admin@tbm.com').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || 'Admin123!';
    const name = process.env.ADMIN_NAME || 'TBM Admin';

    const dbPrefix = process.env.TENANT_DB_PREFIX || 'tenant_';
    const dbName = dbPrefix + tenantId;
    console.log(`Connecting to MongoDB (db: ${dbName})...`);
    await mongoose.connect(process.env.MONGODB_URI, { dbName });
    console.log('Connected\n');

    try {
        const existing = await User.findOne({ email });
        if (existing) {
            console.log('User already exists:');
            console.log(`   Email: ${existing.email}`);
            console.log(`   Role: ${existing.role}`);
            console.log(`   Tenant: ${existing.tenantId}`);
            console.log(`   ID: ${existing._id}`);
            return;
        }

        const user = await User.create({
            name,
            email,
            password,
            role: 'admin',
            tenantId,
            isActive: true
        });

        console.log('Admin user created successfully!');
        console.log('--------------------------------');
        console.log(`   ID:       ${user._id}`);
        console.log(`   Name:     ${user.name}`);
        console.log(`   Email:    ${user.email}`);
        console.log(`   Password: ${password}`);
        console.log(`   Role:     ${user.role}`);
        console.log(`   Tenant:   ${user.tenantId}`);
        console.log('--------------------------------');
    } catch (err) {
        console.error('Error:', err.message);
        if (err.code === 11000) console.error('   (Email already exists)');
        throw err;
    } finally {
        await mongoose.disconnect();
    }
}

run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
