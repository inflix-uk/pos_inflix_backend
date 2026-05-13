/**
 * Backfill tenantId="default" for all documents where tenantId is missing.
 * Run: npm run db:backfill-tenant-default
 * Uses batches and logs counts per model.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');

const DEFAULT_TENANT = 'default';
const BATCH_SIZE = 1000;

const MODELS = [
    { name: 'User', model: () => require('../models/User') },
    { name: 'Location', model: () => require('../models/Location') },
    { name: 'Repair', model: () => require('../models/Repair') },
    { name: 'Sale', model: () => require('../models/Sale') },
    { name: 'SalesReturn', model: () => require('../models/SalesReturn') },
    { name: 'Purchase', model: () => require('../models/Purchase') },
    { name: 'Product', model: () => require('../models/Product') },
    { name: 'Customer', model: () => require('../models/Customer') },
    { name: 'StockMove', model: () => require('../models/StockMove') },
    { name: 'StockBalance', model: () => require('../models/StockBalance') },
    { name: 'SerialLocation', model: () => require('../models/SerialLocation') },
    { name: 'SerialIndex', model: () => require('../models/SerialIndex') },
    { name: 'LocationDailyMetric', model: () => require('../models/LocationDailyMetric') },
    { name: 'TenantDailyMetric', model: () => require('../models/TenantDailyMetric') },
    { name: 'Expense', model: () => require('../models/Expense') },
    { name: 'AuditEvent', model: () => require('../models/AuditEvent') },
    { name: 'StockTransfer', model: () => require('../models/StockTransfer') },
    { name: 'StockAdjustment', model: () => require('../models/StockAdjustment') },
    { name: 'PurchaseReturn', model: () => require('../models/PurchaseReturn') }
];

async function backfillModel(Model, collectionName) {
    const filter = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }] };
    let total = 0;
    let updated = 0;
    while (true) {
        const batch = await Model.find(filter).limit(BATCH_SIZE).lean();
        if (batch.length === 0) break;
        total += batch.length;
        const ids = batch.map((d) => d._id);
        const result = await Model.updateMany(
            { _id: { $in: ids } },
            { $set: { tenantId: DEFAULT_TENANT } }
        );
        updated += result.modifiedCount;
        console.log(`  ${collectionName}: batch updated ${result.modifiedCount} (total so far: ${updated})`);
        if (batch.length < BATCH_SIZE) break;
    }
    return { total, updated };
}

async function run() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGODB_URI or MONGO_URI required');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log('Backfill tenantId=default: connected');

    for (const { name, model } of MODELS) {
        const Model = model();
        const collectionName = Model.collection.name;
        try {
            const { total, updated } = await backfillModel(Model, collectionName);
            if (total > 0) console.log(`${name} (${collectionName}): ${updated} docs updated (${total} without tenantId)`);
            else console.log(`${name} (${collectionName}): no docs missing tenantId`);
        } catch (err) {
            console.error(`${name} (${collectionName}):`, err.message);
        }
    }

    await mongoose.disconnect();
    console.log('Backfill tenantId=default done.');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
