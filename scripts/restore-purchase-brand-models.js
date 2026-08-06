/**
 * Restore missing purchase item brandModel from AuditLog before-snapshots.
 *
 * When purchase edit saved without brandModel (name→ID lookup bug), UPDATE audits
 * still hold the previous items with models. Match live items by IMEI overlap
 * (item _ids are often regenerated on save) and restore brandModel + variantValues.
 *
 * Usage:
 *   node scripts/restore-purchase-brand-models.js [purchaseId]           # dry-run
 *   node scripts/restore-purchase-brand-models.js [purchaseId] --apply   # write
 *   node scripts/restore-purchase-brand-models.js --all                  # dry-run all wiped items
 *   node scripts/restore-purchase-brand-models.js --all --apply
 *
 * Default purchaseId: 6a71f54f97932a23c4d912bc (the reported edit)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const DEFAULT_PURCHASE_ID = '6a71f54f97932a23c4d912bc';
const argId = process.argv.find((a) => /^[a-f0-9]{24}$/i.test(a));
const PURCHASE_ID = ALL ? null : (argId || DEFAULT_PURCHASE_ID);

function imeiKey(imei) {
    return String(imei || '').trim().toUpperCase();
}

function imeiSet(item) {
    return new Set((item.imeis || []).map(imeiKey).filter(Boolean));
}

function overlapCount(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
}

function pickModel(item) {
    const direct = item?.brandModel != null ? String(item.brandModel).trim() : '';
    if (direct) return direct;
    const vv = Array.isArray(item?.variantValues) ? item.variantValues : [];
    const entry = vv.find((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return (s.includes('brand_model') || s.includes('brandmodel') || s === 'model') && v?.value;
    });
    return entry?.value != null ? String(entry.value).trim() : '';
}

function upsertBrandModelVariant(variantValues, model) {
    const arr = Array.isArray(variantValues) ? [...variantValues] : [];
    const idx = arr.findIndex((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return s.includes('brand_model') || s.includes('brandmodel') || s === 'model';
    });
    const value = String(model).trim().toUpperCase();
    if (idx >= 0) arr[idx] = { ...arr[idx], slug: arr[idx].slug || 'brand_model', value };
    else arr.push({ slug: 'brand_model', value });
    return arr;
}

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.useDb('tenant_tbm', { useCache: true });
    const Purchase = db.collection('purchases');
    const AuditLog = db.collection('auditlogs');

    const purchaseFilter = PURCHASE_ID
        ? { _id: new mongoose.Types.ObjectId(PURCHASE_ID) }
        : {};

    const purchases = await Purchase.find(purchaseFilter).toArray();
    if (purchases.length === 0) {
        console.error('No purchases found for filter', PURCHASE_ID || 'all');
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`\nMode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
    console.log(`Purchases scanned: ${purchases.length}\n`);

    const plan = [];

    for (const purchase of purchases) {
        const liveItems = (purchase.items || []).filter((it) => Array.isArray(it.imeis) && it.imeis.length > 0);
        const missing = liveItems.filter((it) => !pickModel(it));
        if (missing.length === 0) continue;

        const entityIds = [purchase._id, String(purchase._id)];
        const audits = await AuditLog.find({
            entityType: 'Purchase',
            action: { $in: ['UPDATE', 'CREATE'] },
            entityId: { $in: entityIds },
        })
            .sort({ performedAt: -1 })
            .toArray();

        // Candidate snapshots: UPDATE.before (newest first), then CREATE.after
        const snapshots = [];
        for (const a of audits) {
            if (a.action === 'UPDATE' && a.changes?.before?.items) {
                snapshots.push({ source: `UPDATE:${a._id}`, items: a.changes.before.items, at: a.performedAt });
            }
            if (a.action === 'CREATE' && a.changes?.after?.items) {
                snapshots.push({ source: `CREATE:${a._id}`, items: a.changes.after.items, at: a.performedAt });
            }
        }

        for (const live of missing) {
            const liveSet = imeiSet(live);
            let best = null;
            for (const snap of snapshots) {
                for (const hist of snap.items || []) {
                    const model = pickModel(hist);
                    if (!model) continue;
                    const histSet = imeiSet(hist);
                    const overlap = overlapCount(liveSet, histSet);
                    if (overlap === 0) continue;
                    const score = overlap * 1000 + (histSet.size === liveSet.size ? 100 : 0);
                    if (!best || score > best.score) {
                        best = {
                            score,
                            overlap,
                            model,
                            brand: hist.brand || live.brand,
                            source: snap.source,
                            histItemId: hist._id,
                        };
                    }
                }
                if (best && best.overlap === liveSet.size) break; // perfect match
            }

            plan.push({
                purchaseId: purchase._id,
                purchaseNumber: purchase.purchaseNumber || '',
                itemId: live._id,
                brand: live.brand || '',
                capacity: live.capacity || '',
                colour: live.colour || '',
                imeiCount: liveSet.size,
                status: best ? 'WILL_RESTORE' : 'NO_SNAPSHOT_MODEL',
                restoreModel: best?.model || '',
                overlap: best?.overlap || 0,
                source: best?.source || '',
            });
        }
    }

    console.log('Purchase | Brand    | Cap   | Colour | IMEIs | Model to restore          | Overlap | Status');
    console.log('---------+----------+-------+--------+-------+---------------------------+---------+----------------');
    for (const p of plan) {
        console.log(
            `${String(p.purchaseNumber || String(p.purchaseId).slice(-6)).padEnd(8)} | ${String(p.brand || '-').padEnd(8)} | ${String(p.capacity || '-').padEnd(5)} | ${String(p.colour || '-').padEnd(6)} | ${String(p.imeiCount).padStart(5)} | ${String(p.restoreModel || '-').padEnd(25)} | ${String(p.overlap).padStart(7)} | ${p.status}`
        );
    }

    const toRestore = plan.filter((p) => p.status === 'WILL_RESTORE');
    console.log(`\nMissing-model items: ${plan.length}`);
    console.log(`Can restore         : ${toRestore.length}`);
    console.log(`No snapshot         : ${plan.filter((p) => p.status === 'NO_SNAPSHOT_MODEL').length}`);

    if (!APPLY) {
        console.log('\nDry-run only. Re-run with --apply to write changes.');
        await mongoose.disconnect();
        return;
    }

    let updated = 0;
    const byPurchase = new Map();
    for (const p of toRestore) {
        const purchase = purchases.find((x) => String(x._id) === String(p.purchaseId));
        if (!purchase) continue;
        const item = (purchase.items || []).find((it) => String(it._id) === String(p.itemId));
        if (!item) continue;
        const model = String(p.restoreModel).trim().toUpperCase();
        item.brandModel = model;
        item.variantValues = upsertBrandModelVariant(item.variantValues, model);
        if (!byPurchase.has(String(p.purchaseId))) byPurchase.set(String(p.purchaseId), purchase);
    }

    for (const [, purchase] of byPurchase) {
        const result = await Purchase.updateOne(
            { _id: purchase._id },
            { $set: { items: purchase.items } }
        );
        if (result.modifiedCount > 0) {
            const n = toRestore.filter((p) => String(p.purchaseId) === String(purchase._id)).length;
            updated += n;
            await AuditLog.insertOne({
                entityType: 'Purchase',
                entityId: purchase._id,
                action: 'ADJUSTMENT',
                changes: {
                    restoreReason:
                        'Restoring brandModel wiped by purchase-edit save (model name treated as option ID). See useEditPurchase buildItemPayload fix.',
                    items: toRestore
                        .filter((p) => String(p.purchaseId) === String(purchase._id))
                        .map((p) => ({
                            itemId: p.itemId,
                            brand: p.brand,
                            capacity: p.capacity,
                            restoredBrandModel: p.restoreModel,
                            source: p.source,
                            imeiOverlap: p.overlap,
                        })),
                },
                performedBy: null,
                performedAt: new Date(),
                source: 'system',
                ip: '',
                userAgent: 'restore-purchase-brand-models.js',
                sessionId: '',
            });
        }
    }

    console.log(`\nDone. Items restored: ${updated}. Purchases updated: ${byPurchase.size}`);
    await mongoose.disconnect();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
