/**
 * Verification script: for each customer with ledger entries, recompute balance from
 * sum(LedgerEntry.amount) and compare to Customer.balance. Report mismatches.
 * Usage: node src/scripts/verify-ledger-balance.js
 * Requires: MONGODB_URI
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function verify() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const customers = await Customer.find({}).lean();
    let ok = 0;
    let fail = 0;

    for (const c of customers) {
        const entries = await LedgerEntry.find({
            accountType: 'customer',
            accountId: c._id
        }).lean();
        const computed = round2(entries.reduce((s, e) => s + (Number(e.amount) || 0), 0));
        const stored = round2(Number(c.balance) || 0);
        if (Math.abs(computed - stored) > 0.01) {
            console.log(`MISMATCH Customer ${c._id} "${c.name}": stored=${stored}, computed=${computed}`);
            fail++;
        } else {
            ok++;
        }
    }

    console.log(`\nVerified ${customers.length} customer(s): ${ok} OK, ${fail} mismatch(es).`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
}

verify().catch((err) => {
    console.error(err);
    process.exit(1);
});
