/**
 * Restore missing purchase item brandModel from audit / serial / sale snapshots.
 *
 * Usage (on a host that can reach Mongo):
 *   node scripts/restore-purchase-brand-models.js [purchaseId]           # dry-run
 *   node scripts/restore-purchase-brand-models.js [purchaseId] --apply   # write
 *   node scripts/restore-purchase-brand-models.js --all                  # dry-run all wiped items
 *   node scripts/restore-purchase-brand-models.js --all --apply
 *   TENANT_ID=tbm node scripts/restore-purchase-brand-models.js --all --apply
 *
 * Default purchaseId: 6a71f54f97932a23c4d912bc (the reported edit)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const tenantContext = require('../src/lib/tenantContext');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const DEFAULT_PURCHASE_ID = '6a71f54f97932a23c4d912bc';
const argId = process.argv.find((a) => /^[a-f0-9]{24}$/i.test(a));
const PURCHASE_ID = ALL ? null : (argId || DEFAULT_PURCHASE_ID);
const TENANT_ID = process.env.TENANT_ID || 'tbm';

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);

    const dbPrefix = config.tenantDbPrefix || 'tenant_';
    const dbName = `${dbPrefix}${TENANT_ID}`;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });

    console.log(`\nTenant: ${TENANT_ID} (db=${dbName})`);
    console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);

    await tenantContext.run({ tenantDb, tenantId: TENANT_ID }, async () => {
        // Require models inside tenant context so proxies bind to tenant DB
        const Purchase = require('../src/models/Purchase');
        const AuditLog = require('../src/models/AuditLog');
        const AuditEvent = require('../src/models/AuditEvent');
        const SerialIndex = require('../src/models/SerialIndex');
        const Sale = require('../src/models/Sale');
        const StockItem = require('../src/models/StockItem');
        const { restorePurchaseBrandModels, pickModel } = require('../src/services/restorePurchaseBrandModels');

        let purchaseIds = [];
        if (PURCHASE_ID) {
            purchaseIds = [PURCHASE_ID];
        } else {
            const wiped = await Purchase.find({
                tenantId: TENANT_ID,
                'items.0': { $exists: true },
            })
                .select('_id items.brandModel items.variantValues items.imeis items.name')
                .lean();
            purchaseIds = wiped
                .filter((p) =>
                    (p.items || []).some(
                        (it) => Array.isArray(it.imeis) && it.imeis.length > 0 && !pickModel(it)
                    )
                )
                .map((p) => String(p._id));
        }

        console.log(`Purchases to process: ${purchaseIds.length}\n`);

        let totalRestored = 0;
        let totalSkipped = 0;

        for (const id of purchaseIds) {
            const result = await restorePurchaseBrandModels({
                Purchase,
                AuditLog,
                AuditEvent,
                SerialIndex,
                Sale,
                StockItem,
                purchaseId: id,
                tenantId: TENANT_ID,
                apply: APPLY,
            });

            console.log(`Purchase ${id}`);
            console.log(`  ${result.message} (snapshots=${result.snapshotCount ?? 0})`);
            for (const r of result.restored || []) {
                console.log(
                    `  RESTORE  ${r.brand || '-'} / ${r.restoredBrandModel} / ${r.capacity || '-'} (${r.imeiCount} imeis) ← ${r.source}`
                );
            }
            for (const s of result.skipped || []) {
                console.log(`  SKIP     ${s.brand || '-'} / ${s.capacity || '-'} (${s.imeiCount} imeis) — ${s.reason}`);
            }
            totalRestored += (result.restored || []).length;
            totalSkipped += (result.skipped || []).length;
        }

        console.log(`\nTotals: restore=${totalRestored} skip=${totalSkipped}`);
        if (!APPLY) console.log('Dry-run only. Re-run with --apply to write changes.');
    });

    await mongoose.disconnect();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
