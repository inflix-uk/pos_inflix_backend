/**
 * Quick diagnostic: read the synced subscription doc from tenant_gnr DB
 * to confirm whether effective.enabledFeatures has sales=false, invoices=true.
 *
 * Run: node scripts/check-gnr-subscription.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TENANT_ID = process.argv[2] || 'gnr';
const URI = process.env.MONGODB_URI;

(async () => {
    if (!URI) { console.error('MONGODB_URI missing in .env'); process.exit(1); }
    const conn = await mongoose.createConnection(URI, { dbName: `tenant_${TENANT_ID}` }).asPromise();
    try {
        const sub = await conn.collection('subscription').findOne({ tenantId: TENANT_ID });
        if (!sub) {
            console.log(`[tenant_${TENANT_ID}.subscription] no document found for tenantId=${TENANT_ID}`);
            return;
        }
        console.log(`\n=== tenant_${TENANT_ID}.subscription ===`);
        console.log('planKey         :', sub.planKey);
        console.log('subscriptionType:', sub.subscriptionType);
        console.log('updatedAtUtc    :', sub.updatedAtUtc);
        console.log('\noverrides.features :', JSON.stringify(sub.overrides?.features || {}, null, 2));
        console.log('\neffective.enabledFeatures :', JSON.stringify(sub.effective?.enabledFeatures || {}, null, 2));
        console.log('\n--- sales/invoice check ---');
        const ef = sub.effective?.enabledFeatures || {};
        console.log(`  effective.sales    = ${ef.sales}   (expect false)`);
        console.log(`  effective.invoices = ${ef.invoices} (expect true)`);
        if (ef.sales === false && ef.invoices === true) {
            console.log('\nOK — tenant DB has the correct mutex state. If POS sidebar still shows Sales, restart the POS backend (cache TTL 60s) and hard-refresh the page.');
        } else {
            console.log('\nMISMATCH — the tenant DB does not have the expected state. Save again from the platform tenant page.');
        }
    } finally {
        await conn.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
