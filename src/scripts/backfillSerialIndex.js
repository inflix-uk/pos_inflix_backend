/**
 * Backfill SerialIndex from SoldSerial, SerialHistory, SerialLocation, Purchase.items.imeis.
 * Priority: sold > returned_to_supplier > adjusted_out > in_transfer > in_stock.
 * Run: npm run db:backfill-serial-index
 */
require('dotenv').config();
const mongoose = require('mongoose');
const SerialIndex = require('../models/SerialIndex');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const SerialLocation = require('../models/SerialLocation');
const Purchase = require('../models/Purchase');
const { normalizeSerial } = require('../utils/serialUtil');

const TENANT_ID = process.env.TENANT_ID || 'default';
const BATCH_SIZE = 500;
const STATUS_PRIORITY = { sold: 5, returned_to_supplier: 4, adjusted_out: 3, in_transfer: 2, in_stock: 1, not_found: 0 };

function getPriority(status) {
    return STATUS_PRIORITY[status] ?? 0;
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/pos_inflix');
    console.log('Backfill SerialIndex: connected');

    const bySerial = new Map();

    // a) SoldSerial -> sold
    const sold = await SoldSerial.find({ status: { $ne: 'returned' } })
        .select('serialNumber')
        .populate('saleId', 'reference customerName')
        .lean();
    for (const d of sold) {
        const serial = normalizeSerial(d.serialNumber);
        if (!serial) continue;
        const existing = bySerial.get(serial);
        if (!existing || getPriority(existing.status) < getPriority('sold')) {
            bySerial.set(serial, {
                serial,
                status: 'sold',
                saleId: d.saleId?._id || null,
                saleReferenceSnapshot: d.saleId?.reference || '',
                customerNameSnapshot: d.saleId?.customerName || ''
            });
        }
    }
    console.log('SoldSerial count:', sold.length, '-> sold entries');

    // b) SerialHistory returned_to_supplier
    const returned = await SerialHistory.find({ eventType: 'returned_to_supplier' }).select('serialNumber').lean();
    for (const d of returned) {
        const serial = normalizeSerial(d.serialNumber);
        if (!serial) continue;
        const existing = bySerial.get(serial);
        if (!existing || getPriority(existing.status) < getPriority('returned_to_supplier')) {
            bySerial.set(serial, { serial, status: 'returned_to_supplier' });
        }
    }
    console.log('SerialHistory returned_to_supplier:', returned.length);

    // c) SerialLocation -> available / in_transfer / adjusted_out
    const slDocs = await SerialLocation.find().select('serialNumber status locationId productId').lean();
    const statusMap = { available: 'in_stock', in_transfer: 'in_transfer', adjusted_out: 'adjusted_out' };
    for (const d of slDocs) {
        const serial = normalizeSerial(d.serialNumber);
        if (!serial) continue;
        const status = statusMap[d.status] || 'in_stock';
        const existing = bySerial.get(serial);
        if (!existing || getPriority(existing.status) < getPriority(status)) {
            bySerial.set(serial, {
                serial,
                status,
                locationId: d.locationId || null,
                productId: d.productId || null
            });
        }
    }
    console.log('SerialLocation count:', slDocs.length);

    // d) Purchase.items.imeis -> in_stock
    const purchases = await Purchase.find({ 'items.imeis': { $exists: true, $ne: [] } })
        .populate('items.category', 'name')
        .lean();
    let purchaseInStockCount = 0;
    for (const p of purchases) {
        const items = p.items || [];
        const purchaseDate = p.createdAt || p.date || new Date();
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const imeis = Array.isArray(it.imeis) ? it.imeis.map((x) => normalizeSerial(x)).filter(Boolean) : [];
            for (const serial of imeis) {
                const existing = bySerial.get(serial);
                if (existing && getPriority(existing.status) >= getPriority('in_stock')) continue;
                const categoryName = (it.category && it.category.name) ? it.category.name : (it.category && typeof it.category === 'string') ? it.category : '';
                const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
                const name = parts.length > 0 ? parts.join(' ') : (it.name && it.name.trim() ? it.name.trim() : 'Product');
                const itemId = it._id || null;
                const skuSnapshot = `${p._id}-${itemId}`;
                bySerial.set(serial, {
                    serial,
                    status: 'in_stock',
                    productNameSnapshot: name,
                    skuSnapshot,
                    purchaseId: p._id,
                    purchaseItemId: itemId,
                    unitCost: Number(it.purchasePrice) || null,
                    salePrice: Number(it.salePrice) || null,
                    locationId: it.sendTo || null,
                    purchaseDate
                });
                purchaseInStockCount++;
            }
        }
    }
    console.log('Purchase items in_stock entries:', purchaseInStockCount);

    const entries = [...bySerial.values()];
    const counts = {};
    entries.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
    console.log('Deduped by status:', counts);

    let written = 0;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const ops = batch.map((e) => ({
            updateOne: {
                filter: { tenantId: TENANT_ID, serial: e.serial },
                update: {
                    $set: {
                        status: e.status,
                        productId: e.productId || null,
                        productNameSnapshot: e.productNameSnapshot || '',
                        skuSnapshot: e.skuSnapshot || '',
                        purchaseId: e.purchaseId || null,
                        purchaseItemId: e.purchaseItemId || null,
                        unitCost: e.unitCost ?? null,
                        salePrice: e.salePrice ?? null,
                        locationId: e.locationId || null,
                        saleId: e.saleId || null,
                        saleReferenceSnapshot: e.saleReferenceSnapshot || '',
                        customerNameSnapshot: e.customerNameSnapshot || '',
                        purchaseDate: e.purchaseDate || null,
                        updatedAt: new Date()
                    }
                },
                upsert: true
            }
        }));
        await SerialIndex.bulkWrite(ops);
        written += batch.length;
        console.log('Upserted', written, '/', entries.length);
    }
    console.log('Backfill done. Total SerialIndex entries:', written);
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
