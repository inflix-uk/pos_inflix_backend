/**
 * List all locations in the database.
 * 
 * Run: node scripts/list-locations.js
 */

const mongoose = require('mongoose');
const Location = require('../src/models/Location');
require('dotenv').config({ path: '.env' });

async function listLocations() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    try {
        const tenantId = 'default';
        const locations = await Location.find({ tenantId }).select('name type isActive _id').lean();

        if (locations.length === 0) {
            console.log('ℹ️  No locations found in the database.');
            console.log('\n📝 To create a location:');
            console.log('   1. Via API: POST /api/locations');
            console.log('      Body: { "name": "Location Name", "type": "store" }');
            console.log('   2. Via UI: Settings → Locations → Create Location');
            console.log('   3. Via script: Create locations first, then assign users\n');
        } else {
            console.log(`📍 Found ${locations.length} location(s):\n`);
            locations.forEach((loc, index) => {
                const status = loc.isActive ? '✅ Active' : '❌ Inactive';
                console.log(`${index + 1}. ${loc.name}`);
                console.log(`   ID: ${loc._id}`);
                console.log(`   Type: ${loc.type || 'store'}`);
                console.log(`   Status: ${status}`);
                console.log('');
            });

            console.log('💡 To create a user with these locations:');
            console.log('   node scripts/create-user-with-locations.js "Name" "email@test.com" "Password123!" "role" "Location1,Location2" "DefaultLocation"');
            console.log('');
        }

    } catch (error) {
        console.error('\n❌ Error listing locations:', error.message);
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    listLocations()
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { listLocations };
