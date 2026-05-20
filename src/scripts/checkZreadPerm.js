/**
 * Quick check: is report.zread present in each tenant's permission catalog?
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('MONGODB_URI required'); process.exit(1); }
    await mongoose.connect(uri);

    const conn = mongoose.connection;
    const adminDb = conn.db.admin();
    const { databases } = await adminDb.listDatabases();

    const tenantNamePattern = /^pos_/i;
    for (const dbInfo of databases) {
        const name = dbInfo.name;
        if (name === 'admin' || name === 'local' || name === 'config') continue;
        const db = conn.useDb(name, { useCache: false });
        try {
            const col = db.collection('permissions');
            const reportPerms = await col.find({ key: /^report\./ }).toArray();
            if (reportPerms.length > 0) {
                console.log(`\n[${name}] report.* permissions:`);
                for (const p of reportPerms) {
                    console.log(`  - ${p.key}  (group: ${p.group}, desc: ${p.description})`);
                }
                const has = reportPerms.some((p) => p.key === 'report.zread');
                console.log(`  report.zread present? ${has ? 'YES' : 'NO'}`);
            }
        } catch (e) {
            // skip dbs without permissions collection
        }
    }

    await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
