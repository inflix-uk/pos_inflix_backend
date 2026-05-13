/**
 * READ-ONLY: build before/after table for tablet salePrices using audit log snapshots.
 * The audit log captures purchases at creation time; the live `salePrice` was later
 * overwritten by syncSalePriceToSameVariant when a new purchase was made.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.useDb('tenant_tbm', { useCache: true });
    const TABLETS_CAT = '69eb7cba8a979fc4d384ae5f';

    const Purchase = db.collection('purchases');
    const AuditLog = db.collection('auditlogs');
    const User = db.collection('users');

    // 1) Live tablet items
    const live = await Purchase.aggregate([
        { $unwind: '$items' },
        { $match: { 'items.category': new mongoose.Types.ObjectId(TABLETS_CAT) } },
        { $project: {
            purchaseId: '$_id',
            createdAt: 1,
            createdBy: 1,
            itemId: '$items._id',
            brand: '$items.brand', model: '$items.brandModel', grade: '$items.grade', cap: '$items.capacity', colour: '$items.colour',
            currentSalePrice: '$items.salePrice', purchasePrice: '$items.purchasePrice'
        }}
    ]).toArray();

    // 2) For each live item, find original salePrice from audit log of that purchase
    const purchaseIds = [...new Set(live.map(r => String(r.purchaseId)))];
    const audits = await AuditLog.find({
        entityType: 'Purchase',
        action: 'CREATE',
        entityId: { $in: purchaseIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).toArray();

    const auditByPurchase = new Map();
    for (const a of audits) auditByPurchase.set(String(a.entityId), a);

    // 3) Match live item back to original via _id inside changes.after.items
    const rows = [];
    for (const r of live) {
        const audit = auditByPurchase.get(String(r.purchaseId));
        let originalSalePrice = null;
        if (audit) {
            const items = audit.changes?.after?.items || [];
            const orig = items.find(it => String(it._id) === String(r.itemId));
            if (orig) originalSalePrice = orig.salePrice;
        }
        rows.push({ ...r, originalSalePrice, who: audit?.performedBy });
    }

    // Resolve users
    const userIds = [...new Set(rows.map(r => r.who).filter(Boolean).map(String))];
    const users = await User.find({ _id: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
    const userMap = new Map(users.map(u => [String(u._id), u.email || u.name]));

    // Sort by purchase createdAt descending
    rows.sort((a, b) => (b.createdAt - a.createdAt));

    console.log('\n=== TABLET PRICES — ORIGINAL vs CURRENT ===\n');
    console.log('PurchaseDate              | Brand    | Model                    | Grade   | Cap   | Colour    | OriginalSale | CurrentSale | Cost  | CreatedBy');
    console.log('--------------------------+----------+--------------------------+---------+-------+-----------+--------------+-------------+-------+------------------------');
    let changedCount = 0;
    for (const r of rows) {
        const date = r.createdAt?.toISOString?.().slice(0, 19).replace('T', ' ') || '-';
        const orig = r.originalSalePrice;
        const cur = r.currentSalePrice;
        const changed = (orig != null && Number(orig) !== Number(cur));
        if (changed) changedCount++;
        const flag = changed ? ' ←CHANGED' : '';
        console.log(
            `${date.padEnd(25)} | ${String(r.brand||'-').padEnd(8)} | ${String(r.model||'-').padEnd(24)} | ${String(r.grade||'-').padEnd(7)} | ${String(r.cap||'-').padEnd(5)} | ${String(r.colour||'-').padEnd(9)} | ${String(orig ?? '?').padEnd(12)} | ${String(cur).padEnd(11)} | ${String(r.purchasePrice ?? '-').padEnd(5)} | ${userMap.get(String(r.who)) || '-'}${flag}`
        );
    }
    console.log(`\nTotal tablet items: ${rows.length}`);
    console.log(`Items where current salePrice differs from original (overwritten by auto-sync): ${changedCount}`);

    // Trigger purchase analysis
    console.log('\n=== TRIGGER PURCHASE ANALYSIS ===');
    console.log('Purchase 8b945e7b created 2026-04-29T19:07:57Z had a TABLET item with NO brand/model/grade/capacity and salePrice=70.');
    console.log('The function syncSalePriceToSameVariant (purchaseController.js:1236) builds an arrayFilter with only set fields.');
    console.log('When variant fields are empty, only `elem.category=TABLETS` was set as the filter, so the updateMany');
    console.log('overwrote salePrice=70 onto EVERY tablet item in the entire tenant.\n');

    // Show that purchase
    const trigger = await Purchase.findOne({ _id: new mongoose.Types.ObjectId('69f23c8d8b945e7b' /* placeholder - use suffix lookup */) });
    // Let's find by suffix instead
    const triggerCandidates = await Purchase.find({ tenantId: 'tbm', createdAt: { $gte: new Date('2026-04-29T19:07:00Z'), $lte: new Date('2026-04-29T19:08:30Z') } }).toArray();
    for (const t of triggerCandidates) {
        console.log('Trigger candidate purchase:', String(t._id));
        const tabletItems = (t.items || []).filter(i => String(i.category) === TABLETS_CAT);
        console.log('  total items:', t.items?.length, 'tablet items:', tabletItems.length);
        const audit = await AuditLog.findOne({ entityId: t._id, action: 'CREATE' });
        const who = audit?.performedBy ? await User.findOne({ _id: audit.performedBy }) : null;
        console.log('  createdBy:', who?.email || who?.name, '| ip:', audit?.ip, '| userAgent:', audit?.userAgent);
        for (const it of tabletItems) {
            console.log(`    item: brand="${it.brand||''}" model="${it.brandModel||''}" grade="${it.grade||''}" cap="${it.capacity||''}" colour="${it.colour||''}" salePrice=${it.salePrice} purchasePrice=${it.purchasePrice}`);
        }
    }

    await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
