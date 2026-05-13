/**
 * Backfill the StockItem collection from Purchase + SoldSerial.
 *
 * Run:
 *   node src/scripts/backfillStockItems.js
 *   TENANT_ID=acme node src/scripts/backfillStockItems.js
 *
 * Safe to re-run; collection is fully rebuilt for the given tenant each time.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const SoldSerial = require('../models/SoldSerial');
const Sale = require('../models/Sale');
const StockItem = require('../models/StockItem');
const { rowsFromPurchase } = require('../services/stockItemService');

const TENANT_ID = process.env.TENANT_ID || 'default';
const BATCH_SIZE = 200;

async function run() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/pos_inflix';
    await mongoose.connect(uri);
    console.log(`[backfillStockItems] connected. tenantId=${TENANT_ID}`);

    const t0 = Date.now();

    // 1) Drop existing rows for this tenant — clean rebuild
    const deleted = await StockItem.deleteMany({ tenantId: TENANT_ID });
    console.log(`[backfillStockItems] cleared ${deleted.deletedCount} stale rows`);

    // 2) Build sold-serial map → { serial → { saleId, customerName, saleReference } }
    const soldDocs = await SoldSerial.find({ status: { $ne: 'returned' } })
        .select('serialNumber saleId')
        .populate('saleId', 'reference customerName status')
        .lean();
    const soldMap = new Map();
    for (const d of soldDocs) {
        if (!d.saleId || d.saleId.status === 'voided') continue;
        const serial = String(d.serialNumber || '').trim();
        if (!serial) continue;
        soldMap.set(serial, {
            saleId: d.saleId._id,
            customerName: d.saleId.customerName || '',
            saleReference: d.saleId.reference || ''
        });
    }
    console.log(`[backfillStockItems] sold-serial map: ${soldMap.size}`);

    // 3) Stream purchases in batches and emit StockItem rows
    let processedPurchases = 0;
    let insertedRows = 0;
    let cursor = Purchase.find({ tenantId: TENANT_ID }).lean().cursor({ batchSize: BATCH_SIZE });

    let batch = [];
    for await (const purchase of cursor) {
        const rows = await rowsFromPurchase(purchase);
        for (const row of rows) {
            if (row.isSerial && row.imei && soldMap.has(row.imei)) {
                const meta = soldMap.get(row.imei);
                row.status = 'sold';
                row.saleId = meta.saleId;
                row.customerName = meta.customerName;
                row.saleReference = meta.saleReference;
                row.soldAt = new Date();
            }
            batch.push(row);
        }
        processedPurchases++;
        if (batch.length >= BATCH_SIZE) {
            try {
                await StockItem.insertMany(batch, { ordered: false });
                insertedRows += batch.length;
            } catch (err) {
                if (err && err.code !== 11000) throw err;
                insertedRows += batch.length - (err.writeErrors?.length || 0);
            }
            batch = [];
        }
        if (processedPurchases % 200 === 0) {
            console.log(`[backfillStockItems] purchases=${processedPurchases} rows=${insertedRows}`);
        }
    }
    if (batch.length > 0) {
        try {
            await StockItem.insertMany(batch, { ordered: false });
            insertedRows += batch.length;
        } catch (err) {
            if (err && err.code !== 11000) throw err;
            insertedRows += batch.length - (err.writeErrors?.length || 0);
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[backfillStockItems] DONE. purchases=${processedPurchases} rows=${insertedRows} in ${elapsed}s`);
    await mongoose.disconnect();
}

if (require.main === module) {
    run().catch((err) => {
        console.error('[backfillStockItems] failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
