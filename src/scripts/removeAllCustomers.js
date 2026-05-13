/**
 * Remove all customers and their ledger entries from the database.
 * Usage: node src/scripts/removeAllCustomers.js [--tenant=tenantId] [--confirm]
 *   --tenant=id   Optional: only delete customers for this tenant (default: all tenants)
 *   --confirm     Required to actually delete; without it the script only prints counts
 * Requires: MONGODB_URI in .env
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');

const args = process.argv.slice(2);
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.split('=')[1] : null;
const confirm = args.includes('--confirm');

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('Missing MONGODB_URI in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const customerQuery = tenantId ? { tenantId } : {};
    const customerCount = await Customer.countDocuments(customerQuery);
    const customerIds = await Customer.find(customerQuery).distinct('_id');
    const ledgerCount = await LedgerEntry.countDocuments({
        accountType: 'customer',
        accountId: { $in: customerIds }
    });

    console.log(`Customers to delete: ${customerCount}${tenantId ? ` (tenant: ${tenantId})` : ' (all tenants)'}`);
    console.log(`Ledger entries (customer) to delete: ${ledgerCount}`);

    if (!confirm) {
        console.log('\nRun with --confirm to perform deletion. Example: node src/scripts/removeAllCustomers.js --confirm');
        await mongoose.disconnect();
        process.exit(0);
        return;
    }

    const ledgerResult = await LedgerEntry.deleteMany({
        accountType: 'customer',
        accountId: { $in: customerIds }
    });
    const customerResult = await Customer.deleteMany(customerQuery);

    console.log(`\nDeleted ${ledgerResult.deletedCount} ledger entry(ies) and ${customerResult.deletedCount} customer(s).`);
    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
