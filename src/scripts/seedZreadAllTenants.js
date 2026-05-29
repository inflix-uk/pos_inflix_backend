/**
 * Insert report.zread permission into every tenant_* database.
 * Idempotent: upsert by key.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PERM = {
    key: 'report.zread',
    description: 'View Z-Report (till closing)',
    group: 'Reports',
};

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('MONGODB_URI required'); process.exit(1); }
    await mongoose.connect(uri);
    const conn = mongoose.connection;
    const { databases } = await conn.db.admin().listDatabases();

    let touched = 0;
    for (const dbInfo of databases) {
        const name = dbInfo.name;
        if (name === 'admin' || name === 'local' || name === 'config') continue;
        const db = conn.useDb(name, { useCache: false });
        try {
            const col = db.collection('permissions');
            // skip dbs that don't look like tenants (no permissions collection or empty)
            const sample = await col.findOne({});
            if (!sample) continue;
            const res = await col.updateOne(
                { key: PERM.key },
                { $set: { key: PERM.key, description: PERM.description, group: PERM.group, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                { upsert: true }
            );
            console.log(`[${name}] upserted report.zread (matched=${res.matchedCount}, modified=${res.modifiedCount}, upsertedId=${res.upsertedId || '-'})`);
            touched++;
        } catch (e) {
            // ignore non-tenant dbs
        }
    }

    console.log(`\nDone. Touched ${touched} database(s).`);
    await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
