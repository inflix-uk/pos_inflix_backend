/**
 * Backfill unit_cost_at_sale (and cost_missing, purchaseId, purchaseItemId) for existing sale lines
 * that have 0 or missing cost. Uses inventory (Purchase purchasePrice) or Product fallback.
 * Run: node src/scripts/backfillSaleLineCosts.js
 * Or: npm run db:backfill-sale-costs (add to package.json)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const salesTransactionService = require('../services/salesTransactionService');

const BATCH_SIZE = 50;

async function backfillSaleLineCosts() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    let updatedCount = 0;
    let stillMissingCount = 0;
    let salesProcessed = 0;

    const sales = await Sale.find({
        type: { $ne: 'repair' },
        'items.0': { $exists: true }
    })
        .select('items type')
        .lean();

    for (let i = 0; i < sales.length; i += BATCH_SIZE) {
        const batch = sales.slice(i, i + BATCH_SIZE);
        for (const sale of batch) {
            const items = sale.items || [];
            const needsBackfill = items.some(
                (it) => (Number(it.unit_cost_at_sale) || 0) === 0 && (Number(it.quantity) || 0) > 0
            );
            if (!needsBackfill) continue;

            const resolved = await salesTransactionService.resolveCostsForSaleItems(
                items.map((it) => ({
                    sku: it.sku,
                    name: it.name,
                    price: it.price,
                    quantity: it.quantity,
                    serialNumbers: it.serialNumbers || [],
                    unit_cost_at_sale: it.unit_cost_at_sale
                })),
                sale.type || 'retail',
                null
            );

            const doc = await Sale.findById(sale._id);
            if (!doc || !doc.items) continue;

            let changed = false;
            for (let j = 0; j < doc.items.length; j++) {
                const existing = doc.items[j];
                const prevCost = Number(existing.unit_cost_at_sale) || 0;
                if (prevCost > 0) continue;

                const r = resolved[j];
                if (!r) continue;

                const newCost = Number(r.unit_cost_at_sale) || 0;
                doc.items[j].unit_cost_at_sale = newCost;
                doc.items[j].cost_missing = !!r.cost_missing;
                doc.items[j].purchaseId = r.purchaseId || undefined;
                doc.items[j].purchaseItemId = r.purchaseItemId || undefined;
                changed = true;
                if (newCost > 0) updatedCount++;
                else stillMissingCount++;
            }

            if (changed) {
                await doc.save();
                salesProcessed++;
            }
        }
    }

    console.log('Backfill complete.');
    console.log('Sale lines updated with cost:', updatedCount);
    console.log('Sale lines still missing cost:', stillMissingCount);
    console.log('Sales documents updated:', salesProcessed);

    await mongoose.disconnect();
    process.exit(0);
}

backfillSaleLineCosts().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
