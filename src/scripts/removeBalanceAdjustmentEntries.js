/**
 * Removes test ledger entries created by the new "Add balance" feature
 * (referenceLabel "Balance added" or "Balance reduced") and reverses the
 * affected Customer.balance.
 *
 * Iterates every tenant_* database since LedgerEntry/Customer are tenant-scoped.
 *
 * Usage: node src/scripts/removeBalanceAdjustmentEntries.js
 * Requires: MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');

const tenantContext = require('../lib/tenantContext');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const config = require('../config');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function processTenant(tenantDb) {
    const filter = {
        type: 'opening_balance',
        referenceLabel: { $in: ['Balance added', 'Balance reduced'] }
    };

    const entries = await LedgerEntry.find(filter).lean();
    if (entries.length === 0) return { found: 0, deleted: 0 };
    console.log(`  Found ${entries.length} balance-adjustment entries.`);

    const customerDelta = new Map();
    for (const e of entries) {
        if (e.accountType !== 'customer') continue;
        const key = String(e.accountId);
        customerDelta.set(key, round2((customerDelta.get(key) || 0) + Number(e.amount || 0)));
    }

    for (const [customerId, delta] of customerDelta.entries()) {
        const c = await Customer.findById(customerId);
        if (!c) {
            console.log(`    - Customer ${customerId} not found, skipping balance reversal`);
            continue;
        }
        const before = round2(Number(c.balance) || 0);
        c.balance = round2(before - delta);
        await c.save();
        console.log(`    - Customer ${c.name || customerId}: balance ${before} -> ${c.balance} (reversed ${delta})`);
    }

    const del = await LedgerEntry.deleteMany(filter);
    console.log(`  Deleted ${del.deletedCount} ledger entries.`);
    return { found: entries.length, deleted: del.deletedCount };
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const dbPrefix = config.tenantDbPrefix || 'tenant_';
    const admin = mongoose.connection.db.admin();
    const { databases } = await admin.listDatabases();
    const tenantDbs = databases.filter((d) => d.name.startsWith(dbPrefix));
    console.log(`Found ${tenantDbs.length} tenant databases.`);

    let totalFound = 0;
    let totalDeleted = 0;
    for (const dbInfo of tenantDbs) {
        const tenantId = dbInfo.name.slice(dbPrefix.length);
        console.log(`\n[${dbInfo.name}]`);
        const tenantDb = mongoose.connection.useDb(dbInfo.name, { useCache: true });
        const result = await tenantContext.run({ tenantDb, tenantId }, () => processTenant(tenantDb));
        totalFound += result.found;
        totalDeleted += result.deleted;
    }

    console.log(`\nTotal: found ${totalFound}, deleted ${totalDeleted}`);
    await mongoose.disconnect();
    console.log('Done.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
