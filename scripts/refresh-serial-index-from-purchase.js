/**
 * Refresh SerialIndex (+ Redis) product snapshots from a purchase/parcel.
 * Use after brandModel was restored on the purchase so Create Sales scans show the model.
 *
 * Usage (Coolify backend container):
 *   TENANT_ID=tbm node scripts/refresh-serial-index-from-purchase.js PUR-000634
 *   TENANT_ID=tbm node scripts/refresh-serial-index-from-purchase.js PUR-000634 --apply
 *   TENANT_ID=tbm node scripts/refresh-serial-index-from-purchase.js 6a71f54f97932a23c4d912bc --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const tenantContext = require('../src/lib/tenantContext');
const { formatProductName } = require('../src/utils/formatProductName');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID || 'tbm';
const TARGET = process.argv.find((a) => a !== '--apply' && !a.includes('node') && !a.endsWith('.js') && a !== TENANT_ID);

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing');
        process.exit(1);
    }
    if (!TARGET) {
        console.error('Pass purchase number (PUR-000634) or purchase ObjectId');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const dbPrefix = config.tenantDbPrefix || 'tenant_';
    const tenantDb = mongoose.connection.useDb(`${dbPrefix}${TENANT_ID}`, { useCache: true });

    await tenantContext.run({ tenantDb, tenantId: TENANT_ID }, async () => {
        const Purchase = require('../src/models/Purchase');
        const SerialIndex = require('../src/models/SerialIndex');
        const serialIndexService = require('../src/services/serialIndexService');
        const stockItemService = require('../src/services/stockItemService');

        const filter = mongoose.Types.ObjectId.isValid(TARGET) && String(TARGET).length === 24
            ? { _id: TARGET, tenantId: TENANT_ID }
            : { purchaseNumber: TARGET, tenantId: TENANT_ID };

        const purchase = await Purchase.findOne(filter);
        if (!purchase) {
            console.error('Purchase not found:', TARGET);
            process.exit(1);
        }

        console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
        console.log(`Purchase ${purchase.purchaseNumber} (${purchase._id})`);

        let planned = 0;
        for (const it of purchase.items || []) {
            if (!Array.isArray(it.imeis) || it.imeis.length === 0) continue;
            const model = it.brandModel ? String(it.brandModel).trim() : '';
            if (!model) {
                console.log(`  skip item ${it._id}: no brandModel`);
                continue;
            }
            const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
            const name = formatProductName(parts.join(' '));
            for (const imei of it.imeis) {
                const serial = serialIndexService.normalizeSerial(imei);
                if (!serial) continue;
                planned += 1;
                const existing = await SerialIndex.findOne({ tenantId: TENANT_ID, serial })
                    .select('status productNameSnapshot brandModelSnapshot')
                    .lean();
                console.log(
                    `  ${serial}  ${existing?.status || 'missing'}  ` +
                    `"${existing?.productNameSnapshot || ''}" / model=${existing?.brandModelSnapshot || '—'}  →  "${name}" / ${model}`
                );
                if (APPLY) {
                    const status = existing?.status === 'sold' ? 'sold' : 'in_stock';
                    await serialIndexService.upsertSerialIndex(TENANT_ID, {
                        serial,
                        status,
                        productNameSnapshot: name,
                        skuSnapshot: `${purchase._id}-${it._id}`,
                        purchaseId: purchase._id,
                        purchaseItemId: it._id,
                        unitCost: Number(it.purchasePrice) || null,
                        salePrice: Number(it.salePrice) || null,
                        locationId: it.sendTo || null,
                        purchaseDate: purchase.createdAt || purchase.date,
                        grade: it.grade,
                        colour: it.colour,
                        brand: it.brand,
                        brandModel: it.brandModel,
                        capacity: it.capacity,
                    });
                }
            }
        }

        console.log(`\nSerials ${APPLY ? 'updated' : 'to update'}: ${planned}`);
        if (APPLY) {
            try {
                await stockItemService.rebuildForPurchase(purchase);
                console.log('StockItem rebuilt for purchase');
            } catch (e) {
                console.warn('StockItem rebuild skipped:', e.message);
            }
        } else {
            console.log('Dry-run only. Re-run with --apply to write.');
        }
    });

    await mongoose.disconnect();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
