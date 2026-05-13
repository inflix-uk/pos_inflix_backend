/**
 * Migrate legacy per-purchase-item SID to per-IMEI SID.
 *
 * Before: each purchase item has one shared `serialItemIdNumber` for all its IMEIs.
 * After:  each item has `imeiSerials: [{ imei, serialItemIdNumber }]` — one unique SID per IMEI.
 *
 * Run:  node src/scripts/migratePerImeiSid.js
 *       (optionally TENANT_ID=foo to scope to one tenant; otherwise migrates all)
 *
 * Idempotent: items that already have `imeiSerials` populated for all their IMEIs are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');

const TENANT_FILTER = process.env.TENANT_ID ? { tenantId: process.env.TENANT_ID } : {};

async function getMaxSidSeq() {
    const result = await Purchase.aggregate([
        { $match: TENANT_FILTER },
        { $unwind: '$items' },
        {
            $project: {
                sids: {
                    $concatArrays: [
                        {
                            $cond: [
                                { $and: [{ $ne: ['$items.serialItemIdNumber', null] }, { $ne: ['$items.serialItemIdNumber', ''] }] },
                                ['$items.serialItemIdNumber'],
                                []
                            ]
                        },
                        {
                            $map: {
                                input: { $ifNull: ['$items.imeiSerials', []] },
                                as: 'is',
                                in: '$$is.serialItemIdNumber'
                            }
                        }
                    ]
                }
            }
        },
        { $unwind: '$sids' },
        { $match: { sids: /^SID-\d{6}$/ } },
        { $sort: { sids: -1 } },
        { $limit: 1 }
    ]);
    if (result.length > 0 && result[0].sids) {
        const m = String(result[0].sids).match(/^SID-(\d{6})$/);
        if (m) return parseInt(m[1], 10);
    }
    return 0;
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/pos_inflix');
    console.log('migratePerImeiSid: connected');
    if (process.env.TENANT_ID) console.log('Scoped to tenantId:', process.env.TENANT_ID);

    let nextSeq = (await getMaxSidSeq()) + 1;
    console.log('Starting nextSeq:', nextSeq);

    const cursor = Purchase.find({
        ...TENANT_FILTER,
        'items.imeis.0': { $exists: true }
    }).cursor();

    let purchasesScanned = 0;
    let purchasesUpdated = 0;
    let itemsMigrated = 0;
    let imeisAssigned = 0;

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        purchasesScanned++;
        let dirty = false;
        const items = Array.isArray(doc.items) ? doc.items : [];
        for (const item of items) {
            if (item.isOtherItem) continue;
            const imeis = Array.isArray(item.imeis) ? item.imeis : [];
            if (imeis.length === 0) continue;

            const existing = Array.isArray(item.imeiSerials) ? item.imeiSerials : [];
            const existingByImei = new Map();
            for (const e of existing) {
                if (e && e.imei) existingByImei.set(String(e.imei).trim(), e.serialItemIdNumber || '');
            }

            const newSerials = [];
            let touched = false;
            for (const raw of imeis) {
                const imeiStr = String(raw || '').trim();
                if (!imeiStr) continue;
                const prior = existingByImei.get(imeiStr);
                if (prior) {
                    newSerials.push({ imei: imeiStr, serialItemIdNumber: prior });
                } else {
                    newSerials.push({ imei: imeiStr, serialItemIdNumber: `SID-${String(nextSeq++).padStart(6, '0')}` });
                    imeisAssigned++;
                    touched = true;
                }
            }
            if (touched || existing.length !== newSerials.length) {
                item.imeiSerials = newSerials;
                itemsMigrated++;
                dirty = true;
            }
        }
        if (dirty) {
            await doc.save();
            purchasesUpdated++;
            if (purchasesUpdated % 50 === 0) console.log('Purchases updated so far:', purchasesUpdated);
        }
    }

    console.log('--- migratePerImeiSid summary ---');
    console.log('Purchases scanned :', purchasesScanned);
    console.log('Purchases updated :', purchasesUpdated);
    console.log('Items migrated    :', itemsMigrated);
    console.log('New SIDs assigned :', imeisAssigned);
    console.log('Final nextSeq     :', nextSeq);

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
