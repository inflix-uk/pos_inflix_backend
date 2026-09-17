/**
 * Rebuild sale line name / brandModel from the purchase parcel that owns the IMEI.
 *
 * Usage (on Coolify backend container):
 *   TENANT_ID=tbm node scripts/repair-sale-item-names-from-purchase.js --serial 352321541658526
 *   TENANT_ID=tbm node scripts/repair-sale-item-names-from-purchase.js --serial 352321541658526 --apply
 *   TENANT_ID=tbm node scripts/repair-sale-item-names-from-purchase.js --reference INV-001312 --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const tenantContext = require('../src/lib/tenantContext');
const { enrichSaleItemsFromPurchase } = require('../src/utils/enrichSaleItemsFromPurchase');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID || 'tbm';

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    if (i < 0) return null;
    return process.argv[i + 1] || null;
}

const SERIAL = argValue('--serial');
const REFERENCE = argValue('--reference');

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing');
        process.exit(1);
    }
    if (!SERIAL && !REFERENCE) {
        console.error('Pass --serial <imei> and/or --reference INV-...');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const dbPrefix = config.tenantDbPrefix || 'tenant_';
    const tenantDb = mongoose.connection.useDb(`${dbPrefix}${TENANT_ID}`, { useCache: true });

    await tenantContext.run({ tenantDb, tenantId: TENANT_ID }, async () => {
        const Sale = require('../src/models/Sale');
        const query = { tenantId: TENANT_ID, status: { $ne: 'voided' } };
        if (REFERENCE) query.reference = REFERENCE.trim();
        if (SERIAL) query['items.serialNumbers'] = SERIAL.trim();

        const sales = await Sale.find(query);
        console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}  matches=${sales.length}`);

        for (const sale of sales) {
            const before = (sale.items || []).map((it) => ({
                name: it.name,
                brandModel: it.brandModel,
                serials: it.serialNumbers,
            }));
            const enriched = await enrichSaleItemsFromPurchase(
                (sale.items || []).map((it) => it.toObject ? it.toObject() : { ...it }),
                TENANT_ID
            );

            let changed = 0;
            for (let i = 0; i < (sale.items || []).length; i++) {
                const next = enriched[i];
                const cur = sale.items[i];
                if (!next) continue;
                if (
                    String(cur.name || '') !== String(next.name || '') ||
                    String(cur.brandModel || '') !== String(next.brandModel || '') ||
                    String(cur.brand || '') !== String(next.brand || '')
                ) {
                    changed += 1;
                    console.log(`  ${sale.reference} item[${i}]`);
                    console.log(`    before: ${cur.name} (model=${cur.brandModel || '—'})`);
                    console.log(`    after:  ${next.name} (model=${next.brandModel || '—'})`);
                    if (APPLY) {
                        cur.name = next.name;
                        cur.brand = next.brand;
                        cur.brandModel = next.brandModel;
                        cur.capacity = next.capacity;
                        cur.colour = next.colour;
                        if (next.grade) cur.grade = next.grade;
                    }
                }
            }
            if (APPLY && changed > 0) {
                sale.markModified('items');
                await sale.save();
                console.log(`  saved ${sale.reference} (${changed} line(s))`);
            } else if (!changed) {
                console.log(`  ${sale.reference}: no changes needed`, before.find((b) =>
                    (b.serials || []).some((s) => String(s).includes(String(SERIAL || '').trim()))
                ));
            }
        }
    });

    await mongoose.disconnect();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
