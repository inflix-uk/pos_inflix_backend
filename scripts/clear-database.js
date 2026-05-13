/**
 * Clear all collections in the database for testing.
 * 
 * WARNING: This script will DELETE ALL DATA in the database.
 * Only use this for development/testing on localhost.
 * 
 * Run: node scripts/clear-database.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: '.env' });

async function clearDatabase() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);  
    }

    // Safety check: Only allow if database name contains 'tenant_' or 'test' or 'dev'
    const dbName = process.env.MONGODB_URI.split('/').pop().split('?')[0];
    const isSafe = dbName.includes('tenant_') || dbName.includes('test') || dbName.includes('dev') || dbName.includes('localhost');
    
    if (!isSafe) {
        console.error('❌ SAFETY CHECK FAILED: Database name does not appear to be a test/dev database');
        console.error(`   Database: ${dbName}`);
        console.error('   This script only works on databases with "tenant_", "test", "dev", or "localhost" in the name');
        process.exit(1);
    }

    console.log('⚠️  WARNING: This will DELETE ALL DATA in the database!');
    console.log(`   Database: ${dbName}`);
    console.log('   Connection: ' + process.env.MONGODB_URI.replace(/\/\/.*@/, '//***@'));
    console.log('\n   Press Ctrl+C within 5 seconds to cancel...\n');

    // Give user 5 seconds to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    console.log('✅ Connected\n');

    try {
        // Get all collection names
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        if (collectionNames.length === 0) {
            console.log('ℹ️  Database is already empty');
            await mongoose.disconnect();
            return;
        }

        console.log(`📋 Found ${collectionNames.length} collections:`);
        collectionNames.forEach(name => console.log(`   - ${name}`));
        console.log('');

        // Drop all collections
        console.log('🗑️  Dropping all collections...\n');
        for (const name of collectionNames) {
            try {
                await db.collection(name).drop();
                console.log(`   ✅ Dropped: ${name}`);
            } catch (error) {
                // Some collections might not exist or be system collections
                if (error.codeName === 'NamespaceNotFound') {
                    console.log(`   ⚠️  Skipped: ${name} (not found)`);
                } else {
                    console.log(`   ❌ Error dropping ${name}: ${error.message}`);
                }
            }
        }

        console.log('\n✅ Database cleared successfully!');
        console.log('\n📝 Next steps:');
        console.log('   1. Restart your backend server');
        console.log('   2. Create a new user via registration or seed script');
        console.log('   3. Test the multi-tenant + multi-location implementation\n');

    } catch (error) {
        console.error('\n❌ Error clearing database:', error.message);
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    clearDatabase()
        .then(() => {
            console.log('✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { clearDatabase };
