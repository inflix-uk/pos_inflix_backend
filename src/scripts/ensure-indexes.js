/**
 * Ensure all required indexes exist (unique, compound) for rigid POS.
 * Safe to run multiple times. Run after schema changes.
 * Usage: node src/scripts/ensure-indexes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Sale = require('../models/Sale');
const SalesReturn = require('../models/SalesReturn');
const SoldSerial = require('../models/SoldSerial');
const AuditLog = require('../models/AuditLog');
const LedgerEntry = require('../models/LedgerEntry');
const SerialIndex = require('../models/SerialIndex');

async function ensureIndexes() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    await Sale.syncIndexes();
    console.log('Sale indexes synced (reference unique, etc.)');

    await SalesReturn.syncIndexes();
    console.log('SalesReturn indexes synced (reference unique sparse)');

    await SoldSerial.syncIndexes();
    console.log('SoldSerial indexes synced (serialNumber unique)');

    await AuditLog.syncIndexes();
    console.log('AuditLog indexes synced');

    await LedgerEntry.syncIndexes();
    console.log('LedgerEntry indexes synced');

    await SerialIndex.syncIndexes();
    console.log('SerialIndex indexes synced (tenantId+serial unique, status, locationId)');

    await mongoose.disconnect();
    console.log('Done.');
}

ensureIndexes().catch((err) => {
    console.error(err);
    process.exit(1);
});
