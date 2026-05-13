/**
 * Assign locations to an existing user.
 * 
 * Usage:
 *   node scripts/assign-locations-to-user.js "user@email.com" "Location1,Location2" "DefaultLocation"
 * 
 * Example:
 *   node scripts/assign-locations-to-user.js "manchester@test.com" "Manchester,St Helens" "Manchester"
 */

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Location = require('../src/models/Location');
require('dotenv').config({ path: '.env' });

async function assignLocationsToUser() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    try {
        const email = process.argv[2];
        const locationNamesStr = process.argv[3] || '';
        const defaultLocationName = process.argv[4] || '';

        if (!email) {
            console.error('❌ Missing required parameters');
            console.error('\nUsage:');
            console.error('  node scripts/assign-locations-to-user.js "user@email.com" "Location1,Location2" "DefaultLocation"');
            console.error('\nExample:');
            console.error('  node scripts/assign-locations-to-user.js "manchester@test.com" "Manchester,St Helens" "Manchester"');
            process.exit(1);
        }

        const tenantId = 'default';

        // Find user
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            console.error(`❌ User not found: ${email}`);
            process.exit(1);
        }

        console.log(`👤 Found user: ${user.name} (${user.email})`);
        console.log(`   Current assigned locations: ${user.assignedLocationIds?.length || 0}`);
        console.log(`   Current default location: ${user.defaultLocationId || 'None'}\n`);

        // List all locations
        const allLocations = await Location.find({ tenantId, isActive: true }).select('name _id').lean();
        console.log('📍 Available locations:');
        allLocations.forEach(loc => {
            console.log(`   - ${loc.name} (${loc._id})`);
        });
        console.log('');

        let assignedLocationIds = [];
        let defaultLocationId = null;

        if (locationNamesStr) {
            const locationNames = locationNamesStr.split(',').map(n => n.trim()).filter(Boolean);
            
            for (const locName of locationNames) {
                const location = allLocations.find(l => 
                    l.name.toLowerCase() === locName.toLowerCase()
                );
                if (location) {
                    assignedLocationIds.push(location._id);
                } else {
                    console.error(`❌ Location not found: "${locName}"`);
                    console.error('   Available locations:', allLocations.map(l => l.name).join(', '));
                    process.exit(1);
                }
            }

            // Set default location
            if (defaultLocationName) {
                const defaultLoc = allLocations.find(l => 
                    l.name.toLowerCase() === defaultLocationName.toLowerCase()
                );
                if (defaultLoc) {
                    defaultLocationId = defaultLoc._id;
                    // Ensure default is in assigned locations
                    if (!assignedLocationIds.some(id => id.toString() === defaultLocationId.toString())) {
                        assignedLocationIds.push(defaultLocationId);
                    }
                } else {
                    console.error(`❌ Default location not found: "${defaultLocationName}"`);
                    process.exit(1);
                }
            } else if (assignedLocationIds.length > 0) {
                // Use first assigned location as default
                defaultLocationId = assignedLocationIds[0];
            }
        }

        // Update user
        console.log('🔄 Updating user...');
        if (assignedLocationIds.length > 0) {
            user.assignedLocationIds = assignedLocationIds;
            user.defaultLocationId = defaultLocationId;
            console.log(`   Assigned Locations: ${locationNamesStr}`);
            console.log(`   Default Location: ${defaultLocationName || 'First assigned location'}`);
        } else {
            // Clear location assignments (user will have access to all)
            user.assignedLocationIds = [];
            user.defaultLocationId = null;
            console.log(`   Clearing location assignments (user will have access to all locations)`);
        }
        console.log('');

        await user.save();

        console.log('✅ User updated successfully!');
        console.log(`   Assigned Locations: ${user.assignedLocationIds?.length || 0}`);
        if (user.assignedLocationIds && user.assignedLocationIds.length > 0) {
            const locNames = await Location.find({ _id: { $in: user.assignedLocationIds } }).select('name').lean();
            console.log(`   Locations: ${locNames.map(l => l.name).join(', ')}`);
            if (user.defaultLocationId) {
                const defaultLoc = await Location.findById(user.defaultLocationId).select('name').lean();
                console.log(`   Default Location: ${defaultLoc?.name || 'None'}`);
            }
        } else {
            console.log(`   Access: All locations (admin-like)`);
        }
        console.log('');

    } catch (error) {
        console.error('\n❌ Error updating user:', error.message);
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    assignLocationsToUser()
        .then(() => {
            console.log('✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { assignLocationsToUser };
