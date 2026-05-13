/**
 * Restore tablet salePrice to original values from audit log snapshots.
 * - Reads each Purchase CREATE audit entry's `changes.after.items[].salePrice`
 * - For each tablet item where live salePrice differs, updates back to the original
 * - Skips items where original is missing/invalid
 * - Writes an AuditLog entry per affected purchase documenting the restore
 *
 * Usage:
 *   node scripts/restore-tablet-prices.js          # dry-run (default)
 *   node scripts/restore-tablet-prices.js --apply  # actually write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.useDb('tenant_tbm', { useCache: true });
    const TABLETS_CAT = '69eb7cba8a979fc4d384ae5f';

    const Purchase = db.collection('purchases');
    const AuditLog = db.collection('auditlogs');

    const live = await Purchase.aggregate([
        { $unwind: '$items' },
        { $match: { 'items.category': new mongoose.Types.ObjectId(TABLETS_CAT) } },
        { $project: {
            purchaseId: '$_id',
            itemId: '$items._id',
            brand: '$items.brand', model: '$items.brandModel', grade: '$items.grade', cap: '$items.capacity', colour: '$items.colour',
            currentSalePrice: '$items.salePrice'
        }}
    ]).toArray();

    const purchaseIds = [...new Set(live.map(r => String(r.purchaseId)))];
    const audits = await AuditLog.find({
        entityType: 'Purchase',
        action: 'CREATE',
        entityId: { $in: purchaseIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).toArray();
    const auditByPurchase = new Map(audits.map(a => [String(a.entityId), a]));

    const plan = [];
    for (const r of live) {
        const audit = auditByPurchase.get(String(r.purchaseId));
        if (!audit) { plan.push({ ...r, status: 'NO_AUDIT_SNAPSHOT' }); continue; }
        const orig = (audit.changes?.after?.items || []).find(it => String(it._id) === String(r.itemId));
        if (!orig) { plan.push({ ...r, status: 'NO_ITEM_IN_SNAPSHOT' }); continue; }
        const originalSalePrice = Number(orig.salePrice);
        if (!Number.isFinite(originalSalePrice) || originalSalePrice < 0) { plan.push({ ...r, status: 'INVALID_ORIGINAL', originalSalePrice }); continue; }
        if (originalSalePrice === Number(r.currentSalePrice)) { plan.push({ ...r, status: 'ALREADY_CORRECT', originalSalePrice }); continue; }
        plan.push({ ...r, status: 'WILL_RESTORE', originalSalePrice });
    }

    console.log(`\nMode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
    console.log('Brand    | Model                    | Cap   | Colour     | Current → Original | Status');
    console.log('---------+--------------------------+-------+------------+--------------------+----------------');
    for (const p of plan) {
        console.log(
            `${String(p.brand||'-').padEnd(8)} | ${String(p.model||'-').padEnd(24)} | ${String(p.cap||'-').padEnd(5)} | ${String(p.colour||'-').padEnd(10)} | ${String(p.currentSalePrice).padStart(7)} → ${String(p.originalSalePrice ?? '?').padEnd(7)}    | ${p.status}`
        );
    }

    const toRestore = plan.filter(p => p.status === 'WILL_RESTORE');
    console.log(`\nTotal items: ${plan.length}`);
    console.log(`To restore : ${toRestore.length}`);
    console.log(`Already OK : ${plan.filter(p => p.status === 'ALREADY_CORRECT').length}`);
    console.log(`Skipped    : ${plan.filter(p => !['WILL_RESTORE','ALREADY_CORRECT'].includes(p.status)).length}`);

    if (!APPLY) {
        console.log('\nDry-run only. Re-run with --apply to write changes.');
        await mongoose.disconnect();
        return;
    }

    // Apply
    let updatedItems = 0;
    const affectedPurchases = new Set();
    for (const p of toRestore) {
        const result = await Purchase.updateOne(
            { _id: p.purchaseId, 'items._id': p.itemId },
            { $set: { 'items.$.salePrice': p.originalSalePrice } }
        );
        if (result.modifiedCount > 0) {
            updatedItems++;
            affectedPurchases.add(String(p.purchaseId));
        }
    }

    // Audit-log a summary entry for the restore (one per purchase)
    for (const purchaseIdStr of affectedPurchases) {
        const items = toRestore.filter(p => String(p.purchaseId) === purchaseIdStr).map(p => ({
            itemId: p.itemId,
            brand: p.brand, brandModel: p.model, grade: p.grade, capacity: p.cap, colour: p.colour,
            from: p.currentSalePrice,
            to: p.originalSalePrice
        }));
        await AuditLog.insertOne({
            entityType: 'Purchase',
            entityId: new mongoose.Types.ObjectId(purchaseIdStr),
            action: 'ADJUSTMENT',
            changes: { restoreReason: 'Reverting unintended salePrice overwrite caused by syncSalePriceToSameVariant() — see purchaseController.js:1236', items },
            performedBy: null,
            performedAt: new Date(),
            source: 'system',
            ip: '',
            userAgent: 'restore-tablet-prices.js',
            sessionId: ''
        });
    }

    console.log(`\nDone. Items updated: ${updatedItems}. Purchases audit-logged: ${affectedPurchases.size}`);
    await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
