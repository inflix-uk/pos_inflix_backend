/**
 * Create the first user (admin) in the database.
 * Since the database is empty, the first user will automatically be an admin.
 * 
 * Run: node scripts/create-first-user.js
 */

const mongoose = require('mongoose');
const User = require('../src/models/User');
require('dotenv').config({ path: '.env' });

async function createFirstUser() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    try {
        // Check if any users exist
        const userCount = await User.countDocuments();
        if (userCount > 0) {
            console.log('ℹ️  Users already exist in the database');
            const users = await User.find().select('name email role tenantId').lean();
            console.log('\nExisting users:');
            users.forEach(u => {
                console.log(`   - ${u.name} (${u.email}) - ${u.role} - tenant: ${u.tenantId || 'null'}`);
            });
            console.log('\n💡 To create additional users, use the /api/auth/register endpoint (requires admin)');
            console.log('   or use the /api/admin/users endpoint (requires user.manage permission)\n');
            await mongoose.disconnect();
            return;
        }

        // Default user details (you can modify these)
        const defaultUser = {
            name: 'Admin User',
            email: 'admin@test.com',
            password: 'Admin123!',
            role: 'admin',
            tenantId: 'default',
            isActive: true
        };

        // Allow override via environment variables or command line args
        const name = process.env.FIRST_USER_NAME || process.argv[2] || defaultUser.name;
        const email = process.env.FIRST_USER_EMAIL || process.argv[3] || defaultUser.email;
        const password = process.env.FIRST_USER_PASSWORD || process.argv[4] || defaultUser.password;

        console.log('👤 Creating first user (admin)...');
        console.log(`   Name: ${name}`);
        console.log(`   Email: ${email}`);
        console.log(`   Password: ${password}`);
        console.log(`   Tenant: default\n`);

        const user = await User.create({
            name,
            email: email.toLowerCase().trim(),
            password,
            role: 'admin',
            tenantId: 'default',
            isActive: true
        });

        console.log('✅ User created successfully!');
        console.log(`   ID: ${user._id}`);
        console.log(`   Email: ${user.email}`);
        console.log(`   Role: ${user.role}`);
        console.log(`   Tenant: ${user.tenantId}\n`);

        console.log('📝 Next steps:');
        console.log('   1. Login at http://localhost:3000/login');
        console.log(`   2. Use email: ${email}`);
        console.log(`   3. Use password: ${password}`);
        console.log('   4. Create locations, products, and other users\n');

    } catch (error) {
        console.error('\n❌ Error creating user:', error.message);
        if (error.code === 11000) {
            console.error('   Email already exists');
        }
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    createFirstUser()
        .then(() => {
            console.log('✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { createFirstUser };
