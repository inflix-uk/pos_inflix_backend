const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const PricingGroup = require('../models/PricingGroup');

const DEFAULT_GROUPS = [
    { name: 'Wholesale' },
    { name: 'VIP' },
    { name: 'Trade' }
];

const TENANT_DEFAULT = 'default';

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
};

const seedPricingGroups = async () => {
    try {
        await connectDB();
        console.log('\nSeeding pricing groups...');
        for (const { name } of DEFAULT_GROUPS) {
            const existing = await PricingGroup.findOne({ tenantId: TENANT_DEFAULT, name });
            if (!existing) {
                await PricingGroup.create({ name, tenantId: TENANT_DEFAULT });
                console.log('  Created:', name);
            } else {
                console.log('  Exists:', name);
            }
        }
        console.log('Pricing groups seed done.\n');
        process.exit(0);
    } catch (error) {
        console.error('Seed failed:', error.message);
        process.exit(1);
    }
};

seedPricingGroups();
