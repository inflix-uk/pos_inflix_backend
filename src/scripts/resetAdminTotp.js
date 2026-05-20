/**
 * Force-clear admin Google Authenticator (TOTP) state on GeneralSettings.
 * Removes adminTotpSecret and sets adminTotpEnabled=false on all tenant databases.
 * Run: node src/scripts/resetAdminTotp.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const cache = require('../lib/cache');

async function resetAdminTotp() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
    const conn = mongoose.connection;
    const adminDb = conn.useDb('admin');
    const dbs = await adminDb.db.admin().listDatabases();
    let totalMatched = 0;
    for (const dbInfo of dbs.databases) {
        const name = dbInfo.name;
        if (['admin', 'local', 'config'].includes(name)) continue;
        const db = conn.useDb(name);
        const collections = await db.db.listCollections({ name: 'generalsettings' }).toArray();
        if (collections.length === 0) continue;
        const res = await db.collection('generalsettings').updateMany(
            {},
            { $set: { adminTotpSecret: null, adminTotpEnabled: false } }
        );
        // Derive tenantId from db name: `tenant_<id>` or use the raw db name (matches getTenantIdFromReq logic).
        const tenantId = name.startsWith('tenant_') ? name.slice('tenant_'.length) : name;
        try {
            await cache.bumpNs('settings:general', tenantId);
        } catch (e) {
            console.warn(`[${name}] cache bump failed: ${e.message}`);
        }
        console.log(`[${name}] matched=${res.matchedCount} modified=${res.modifiedCount} cacheBumped=settings:general@${tenantId}`);
        totalMatched += res.matchedCount;
    }
    // Also bump the wildcard/default namespace just in case cache key wasn't tenant-scoped.
    try { await cache.bumpNs('settings:general', ''); } catch {}
    try { await cache.bumpNs('settings:general', 'default'); } catch {}
    console.log(`Done. Total documents touched: ${totalMatched}`);
    await mongoose.disconnect();
    process.exit(0);
}

resetAdminTotp().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
