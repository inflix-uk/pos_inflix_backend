/**
 * Create a user and assign them to specific locations.
 * 
 * Usage:
 *   node scripts/create-user-with-locations.js "User Name" "user@email.com" "Password123!" "manager" "Location1,Location2"
 * 
 * Or set environment variables:
 *   USER_NAME="User Name"
 *   USER_EMAIL="user@email.com"
 *   USER_PASSWORD="Password123!"
 *   USER_ROLE="manager"
 *   LOCATION_NAMES="Location1,Location2"
 *   DEFAULT_LOCATION="Location1"
 */

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Location = require('../src/models/Location');
require('dotenv').config({ path: '.env' });

async function createUserWithLocations() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    try {
        // Get parameters
        const name = process.env.USER_NAME || process.argv[2];
        const email = process.env.USER_EMAIL || process.argv[3];
        const password = process.env.USER_PASSWORD || process.argv[4];
        const role = process.env.USER_ROLE || process.argv[5] || 'cashier';
        const locationNamesStr = process.env.LOCATION_NAMES || process.argv[6] || '';
        const defaultLocationName = process.env.DEFAULT_LOCATION || process.argv[7] || '';

        if (!name || !email || !password) {
            console.error('❌ Missing required parameters');
            console.error('\nUsage:');
            console.error('  node scripts/create-user-with-locations.js "Name" "email@test.com" "Password123!" "role" "Location1,Location2" "DefaultLocation"');
            console.error('\nOr set environment variables:');
            console.error('  USER_NAME="Name"');
            console.error('  USER_EMAIL="email@test.com"');
            console.error('  USER_PASSWORD="Password123!"');
            console.error('  USER_ROLE="manager" (optional, default: cashier)');
            console.error('  LOCATION_NAMES="Location1,Location2" (optional)');
            console.error('  DEFAULT_LOCATION="Location1" (optional)');
            process.exit(1);
        }

        const tenantId = 'default'; // Default tenant for localhost

        // List all locations first
        const allLocations = await Location.find({ tenantId, isActive: true }).select('name _id').lean();
        console.log('📍 Available locations:');
        if (allLocations.length === 0) {
            console.log('   ⚠️  No locations found. Create locations first via the UI or API.');
            console.log('   API: POST /api/locations');
            console.log('   Required fields: { name: "Location Name", type: "store" }\n');
        } else {
            allLocations.forEach(loc => {
                console.log(`   - ${loc.name} (${loc._id})`);
            });
            console.log('');
        }

        // Parse location names
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

        // Check if user already exists
        const existing = await User.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            console.error(`❌ User with email ${email} already exists`);
            process.exit(1);
        }

        // Create user
        console.log('👤 Creating user...');
        console.log(`   Name: ${name}`);
        console.log(`   Email: ${email}`);
        console.log(`   Role: ${role}`);
        console.log(`   Tenant: ${tenantId}`);
        if (assignedLocationIds.length > 0) {
            console.log(`   Assigned Locations: ${locationNamesStr}`);
            console.log(`   Default Location: ${defaultLocationName || 'First assigned location'}`);
        } else {
            console.log(`   Assigned Locations: None (user will have access to all locations)`);
        }
        console.log('');

        const user = await User.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password,
            role,
            tenantId,
            isActive: true,
            assignedLocationIds: assignedLocationIds.length > 0 ? assignedLocationIds : undefined,
            defaultLocationId: defaultLocationId || undefined
        });

        console.log('✅ User created successfully!');
        console.log(`   ID: ${user._id}`);
        console.log(`   Email: ${user.email}`);
        console.log(`   Role: ${user.role}`);
        console.log(`   Tenant: ${user.tenantId}`);
        if (user.assignedLocationIds && user.assignedLocationIds.length > 0) {
            console.log(`   Assigned Locations: ${user.assignedLocationIds.length}`);
            console.log(`   Default Location: ${user.defaultLocationId || 'None'}`);
        } else {
            console.log(`   Assigned Locations: None (access to all locations)`);
        }
        console.log('');

        console.log('📝 Next steps:');
        console.log(`   1. Login at http://localhost:3000/login`);
        console.log(`   2. Email: ${email}`);
        console.log(`   3. Password: ${password}`);
        if (assignedLocationIds.length > 0) {
            console.log(`   4. This user will only see data from assigned locations`);
        } else {
            console.log(`   4. This user will see data from all locations (admin-like access)`);
        }
        console.log('');

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
    createUserWithLocations()
        .then(() => {
            console.log('✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { createUserWithLocations };
