/**
 * Backfill occurred_at for existing records (non-destructive).
 * Run once after deploying rigid POS changes. Safe to run multiple times (idempotent for nulls).
 * Usage: node src/scripts/backfill-occurred-at.js
 * Requires: MONGODB_URI in env or .env
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const LedgerEntry = require('../models/LedgerEntry');

async function backfill() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    let saleCount = 0;
    const sales = await Sale.find({ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }).lean();
    for (const s of sales) {
        await Sale.updateOne(
            { _id: s._id },
            { $set: { occurredAt: s.createdAt || s.date || new Date() } }
        );
        saleCount++;
    }
    console.log(`Backfilled occurredAt for ${saleCount} Sale(s)`);

    let returnCount = 0;
    const returns = await SalesReturn.find({ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }).lean();
    for (const r of returns) {
        await SalesReturn.updateOne(
            { _id: r._id },
            { $set: { occurredAt: r.createdAt || r.date || new Date() } }
        );
        returnCount++;
    }
    console.log(`Backfilled occurredAt for ${returnCount} SalesReturn(s)`);

    let ledgerCount = 0;
    const ledgers = await LedgerEntry.find({ $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] }).lean();
    for (const l of ledgers) {
        await LedgerEntry.updateOne(
            { _id: l._id },
            { $set: { occurredAt: l.createdAt || l.date || new Date() } }
        );
        ledgerCount++;
    }
    console.log(`Backfilled occurredAt for ${ledgerCount} LedgerEntry(ies)`);

    await mongoose.disconnect();
    console.log('Done.');
}

backfill().catch((err) => {
    console.error(err);
    process.exit(1);
});
