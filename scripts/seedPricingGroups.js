/**
 * One-time seed: create default pricing groups (Wholesale, VIP, Trade) for tenant 'default' if they don't exist.
 * Run from backend root: node scripts/seedPricingGroups.js
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const DEFAULT_GROUPS = ['Wholesale', 'VIP', 'Trade'];
const TENANT_ID = process.env.TENANT_ID || 'default';

async function seed() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/pos';
    await mongoose.connect(uri);
    const PricingGroup = require(path.join(__dirname, '../src/models/PricingGroup'));

    try {
        const existing = await PricingGroup.find({ tenantId: TENANT_ID }).lean();
        const existingNames = new Set((existing || []).map((g) => g.name));
        for (const name of DEFAULT_GROUPS) {
            if (!existingNames.has(name)) {
                await PricingGroup.create({ name, tenantId: TENANT_ID });
                console.log('Created pricing group:', name);
            }
        }
        console.log('Pricing groups seed done.');
    } finally {
        await mongoose.disconnect();
    }
}

seed().catch((err) => {
    console.error(err);
    process.exit(1);
});
