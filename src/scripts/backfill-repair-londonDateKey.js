/**
 * Backfill londonDateKey on Repairs where missing (computed from createdAt, Europe/London).
 * Run: npm run db:backfill-repair-datekeys
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Repair = require('../models/Repair');
const { getLondonDateKey } = require('../utils/dateKey');

const BATCH_SIZE = 500;

async function run() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGODB_URI or MONGO_URI required');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log('Backfill repair londonDateKey: connected');

    const filter = { $or: [{ londonDateKey: { $exists: false } }, { londonDateKey: null }, { londonDateKey: '' }] };
    let total = 0;
    let updated = 0;

    while (true) {
        const batch = await Repair.find(filter).limit(BATCH_SIZE).select('_id createdAt').lean();
        if (batch.length === 0) break;
        total += batch.length;
        for (const doc of batch) {
            const dateKey = getLondonDateKey(doc.createdAt || new Date());
            await Repair.updateOne({ _id: doc._id }, { $set: { londonDateKey: dateKey } });
            updated++;
        }
        console.log(`  Repairs: batch of ${batch.length} updated (total so far: ${updated})`);
        if (batch.length < BATCH_SIZE) break;
    }

    await mongoose.disconnect();
    console.log(`Backfill repair londonDateKey done. Updated ${updated} of ${total} without londonDateKey.`);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
