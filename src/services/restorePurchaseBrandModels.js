/**
 * Restore missing brandModel on purchase items from audit snapshots / serial index / sales.
 * Shared by CLI script and API endpoint.
 */
const mongoose = require('mongoose');

function imeiKey(imei) {
    return String(imei || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function imeiSet(item) {
    return new Set((Array.isArray(item?.imeis) ? item.imeis : []).map(imeiKey).filter(Boolean));
}

function overlapCount(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Infer model from product name snapshot e.g. "APPLE IPHONE 7 32GB GOLD". */
function inferModelFromProductName(name, brand, capacity, colour) {
    if (!name || !String(name).trim()) return '';
    let s = String(name).trim().toUpperCase().replace(/\s+/g, ' ');
    const b = brand ? String(brand).trim().toUpperCase() : '';
    const cap = capacity ? String(capacity).trim().toUpperCase() : '';
    const col = colour ? String(colour).trim().toUpperCase() : '';
    if (b && s.startsWith(b + ' ')) s = s.slice(b.length).trim();
    else if (b && s === b) return '';
    if (col) s = s.replace(new RegExp(`\\s*${escapeRe(col)}\\s*$`), '').trim();
    if (cap) s = s.replace(new RegExp(`\\s*${escapeRe(cap)}\\s*`), ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(MOBILE|PHONE|HANDSET)\s+/i, '').trim();
    if (!s || s === b || s === cap || s === col) return '';
    if (!/[A-Z]/.test(s)) return '';
    // Avoid restoring names that are just leftover punctuation/numbers
    if (s.length < 2) return '';
    return s;
}

function pickModel(item) {
    const direct = item?.brandModel != null ? String(item.brandModel).trim() : '';
    if (direct) return direct;
    const vv = Array.isArray(item?.variantValues) ? item.variantValues : [];
    const entry = vv.find((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return (
            (s.includes('brand_model') ||
                s.includes('brands_model') ||
                s.includes('brandmodel') ||
                s === 'model' ||
                s === 'models') &&
            v?.value
        );
    });
    if (entry?.value != null && String(entry.value).trim()) return String(entry.value).trim();
    const fromName = inferModelFromProductName(item?.name, item?.brand, item?.capacity, item?.colour);
    return fromName || '';
}

function upsertBrandModelVariant(variantValues, model) {
    const arr = Array.isArray(variantValues) ? variantValues.map((v) => ({ ...v })) : [];
    const idx = arr.findIndex((v) => {
        const s = String(v?.slug || '').toLowerCase();
        return s.includes('brand_model') || s.includes('brands_model') || s.includes('brandmodel') || s === 'model';
    });
    const value = String(model).trim().toUpperCase();
    if (idx >= 0) arr[idx] = { ...arr[idx], slug: arr[idx].slug || 'brand_model', value };
    else arr.push({ slug: 'brand_model', value });
    return arr;
}

function attrKey(item) {
    return [item?.brand, item?.capacity, item?.colour, item?.grade]
        .map((x) => String(x || '').trim().toUpperCase())
        .join('|');
}

function collectSnapshotsFromAudits(auditLogs, auditEvents) {
    const snapshots = [];
    for (const a of auditLogs || []) {
        const beforeItems = a.changes?.before?.items;
        const afterItems = a.changes?.after?.items;
        if (beforeItems?.length) {
            snapshots.push({
                source: `auditlog:before:${a.action}:${a._id}`,
                items: beforeItems,
                at: a.performedAt || a.created_at || a.createdAt,
            });
        }
        if (afterItems?.length && (a.action === 'CREATE' || a.action === 'UPDATE')) {
            snapshots.push({
                source: `auditlog:after:${a.action}:${a._id}`,
                items: afterItems,
                at: a.performedAt || a.created_at || a.createdAt,
            });
        }
    }
    for (const e of auditEvents || []) {
        const beforeItems = e.beforeJson?.items;
        const afterItems = e.afterJson?.items;
        if (beforeItems?.length) {
            snapshots.push({
                source: `auditevent:before:${e._id}`,
                items: beforeItems,
                at: e.occurredAtUtc,
            });
        }
        if (afterItems?.length) {
            snapshots.push({
                source: `auditevent:after:${e._id}`,
                items: afterItems,
                at: e.occurredAtUtc,
            });
        }
    }
    // Prefer older snapshots first for model recovery (pre-wipe values)
    snapshots.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
    return snapshots;
}

function findModelInSnapshots(liveItem, snapshots) {
    const liveSet = imeiSet(liveItem);
    const liveAttr = attrKey(liveItem);
    let best = null;

    for (const snap of snapshots) {
        for (const hist of snap.items || []) {
            const model = pickModel(hist);
            if (!model) continue;
            const histSet = imeiSet(hist);
            const overlap = overlapCount(liveSet, histSet);
            if (overlap > 0) {
                const score = overlap * 1000 + (histSet.size === liveSet.size ? 100 : 0);
                if (!best || score > best.score) {
                    best = { score, overlap, model, source: snap.source };
                }
                continue;
            }
            // Soft match: same brand + capacity/colour when IMEI sets don't overlap
            if (
                liveItem?.brand &&
                (liveItem?.capacity || liveItem?.colour) &&
                liveAttr &&
                !liveAttr.startsWith('|') &&
                attrKey(hist) === liveAttr
            ) {
                const score = 50;
                if (!best || score > best.score) {
                    best = { score, overlap: 0, model, source: `${snap.source}:attr` };
                }
            }
        }
        if (best && best.overlap === liveSet.size && liveSet.size > 0) break;
    }
    return best;
}

function voteModel(votesMap) {
    let top = null;
    for (const [model, meta] of votesMap) {
        if (!top || meta.count > top.count) top = { model, count: meta.count, source: meta.source };
    }
    return top;
}

/**
 * @param {object} opts
 * @param {import('mongoose').Model} opts.Purchase
 * @param {import('mongoose').Model} [opts.AuditLog]
 * @param {import('mongoose').Model} [opts.AuditEvent]
 * @param {import('mongoose').Model} [opts.SerialIndex]
 * @param {import('mongoose').Model} [opts.Sale]
 * @param {import('mongoose').Model} [opts.StockItem]
 * @param {string|object} opts.purchaseId
 * @param {string} [opts.tenantId]
 * @param {boolean} [opts.apply=true]
 */
async function restorePurchaseBrandModels(opts) {
    const {
        Purchase,
        AuditLog,
        AuditEvent,
        SerialIndex,
        Sale,
        StockItem,
        purchaseId,
        tenantId,
        apply = true,
    } = opts;

    const purchase = await Purchase.findById(purchaseId);
    if (!purchase) {
        return { success: false, message: 'Purchase not found', restored: [], skipped: [] };
    }

    const liveItems = (purchase.items || []).filter((it) => Array.isArray(it.imeis) && it.imeis.length > 0);
    const missing = liveItems.filter((it) => !pickModel(it));
    if (missing.length === 0) {
        return {
            success: true,
            message: 'No items missing brandModel',
            restored: [],
            skipped: [],
            purchaseId: String(purchase._id),
        };
    }

    const idVariants = [purchase._id, String(purchase._id)];
    if (mongoose.Types.ObjectId.isValid(String(purchaseId))) {
        idVariants.push(new mongoose.Types.ObjectId(String(purchaseId)));
    }

    let auditLogs = [];
    if (AuditLog) {
        auditLogs = await AuditLog.find({
            entityType: { $in: ['Purchase', 'Parcel'] },
            action: { $in: ['UPDATE', 'CREATE', 'ADJUSTMENT'] },
            entityId: { $in: idVariants },
        })
            .sort({ performedAt: 1 })
            .lean();
    }

    let auditEvents = [];
    if (AuditEvent) {
        const evQuery = {
            entityType: { $in: ['Purchase', 'Parcel'] },
            action: {
                $in: [
                    'PARCEL_UPDATED',
                    'PARCEL_CREATED',
                    'PARCEL_ITEM_DELETED',
                    'PARCEL_STATUS_CHANGED',
                    'UPDATE',
                    'CREATE',
                ],
            },
            entityId: { $in: idVariants },
        };
        if (tenantId) evQuery.tenantId = tenantId;
        auditEvents = await AuditEvent.find(evQuery).sort({ occurredAtUtc: 1 }).lean();
    }

    const snapshots = collectSnapshotsFromAudits(auditLogs, auditEvents);

    const allImeis = [...new Set(missing.flatMap((it) => (it.imeis || []).map(imeiKey)).filter(Boolean))];
    const serialModelByImei = new Map();

    if (SerialIndex && allImeis.length > 0) {
        const serialQuery = {
            $or: [{ serial: { $in: allImeis } }, { serial: { $in: missing.flatMap((it) => it.imeis || []) } }],
        };
        if (tenantId) serialQuery.tenantId = tenantId;
        const docs = await SerialIndex.find(serialQuery)
            .select('serial brandModelSnapshot productNameSnapshot brandSnapshot capacitySnapshot colourSnapshot')
            .lean();
        for (const d of docs) {
            const serial = imeiKey(d.serial);
            const fromField = d.brandModelSnapshot ? String(d.brandModelSnapshot).trim() : '';
            const inferred = inferModelFromProductName(
                d.productNameSnapshot,
                d.brandSnapshot,
                d.capacitySnapshot,
                d.colourSnapshot
            );
            const model = fromField || inferred;
            if (model) {
                serialModelByImei.set(serial, {
                    model,
                    source: fromField ? 'serial_index.brandModel' : 'serial_index.name',
                });
            }
        }
    }

    if (StockItem && allImeis.length > 0) {
        const stockQuery = {
            purchaseId: purchase._id,
            imei: { $in: [...allImeis, ...missing.flatMap((it) => it.imeis || [])] },
        };
        if (tenantId) stockQuery.tenantId = tenantId;
        const docs = await StockItem.find(stockQuery).select('imei brandModel name brand capacity colour').lean();
        for (const d of docs) {
            const serial = imeiKey(d.imei);
            if (!serial || serialModelByImei.has(serial)) continue;
            const fromField = d.brandModel ? String(d.brandModel).trim() : '';
            const inferred = inferModelFromProductName(d.name, d.brand, d.capacity, d.colour);
            const model = fromField || inferred;
            if (model) {
                serialModelByImei.set(serial, {
                    model,
                    source: fromField ? 'stock_item.brandModel' : 'stock_item.name',
                });
            }
        }
    }

    if (Sale && allImeis.length > 0) {
        const saleQuery = {
            'items.serialNumbers': { $in: [...allImeis, ...missing.flatMap((it) => it.imeis || [])] },
        };
        if (tenantId) saleQuery.tenantId = tenantId;
        const sales = await Sale.find(saleQuery).select('items.serialNumbers items.brandModel items.name items.brand items.capacity items.colour').lean();
        for (const sale of sales) {
            for (const line of sale.items || []) {
                const model =
                    (line.brandModel && String(line.brandModel).trim()) ||
                    inferModelFromProductName(line.name, line.brand, line.capacity, line.colour);
                if (!model) continue;
                for (const sn of line.serialNumbers || []) {
                    const serial = imeiKey(sn);
                    if (serial && !serialModelByImei.has(serial)) {
                        serialModelByImei.set(serial, { model, source: 'sale.line' });
                    }
                }
            }
        }
    }

    const restored = [];
    const skipped = [];

    for (const live of missing) {
        let best = findModelInSnapshots(live, snapshots);
        if (!best) {
            const votes = new Map();
            for (const imei of imeiSet(live)) {
                const hit = serialModelByImei.get(imei);
                if (!hit) continue;
                const cur = votes.get(hit.model) || { count: 0, source: hit.source };
                cur.count += 1;
                votes.set(hit.model, cur);
            }
            const top = voteModel(votes);
            if (top && top.count > 0) {
                best = { model: top.model, overlap: top.count, source: top.source, score: top.count };
            }
        }

        if (!best?.model) {
            skipped.push({
                itemId: String(live._id),
                brand: live.brand || '',
                capacity: live.capacity || '',
                imeiCount: imeiSet(live).size,
                reason: 'NO_SOURCE',
            });
            continue;
        }

        const model = String(best.model).trim().toUpperCase();
        restored.push({
            itemId: String(live._id),
            brand: live.brand || '',
            capacity: live.capacity || '',
            colour: live.colour || '',
            imeiCount: imeiSet(live).size,
            restoredBrandModel: model,
            source: best.source,
            overlap: best.overlap || 0,
        });

        if (apply) {
            live.brandModel = model;
            live.variantValues = upsertBrandModelVariant(live.variantValues, model);
            live.markModified?.('variantValues');
            // Keep denormalized item.name in sync so stock/invoice UIs that read name stay correct
            const parts = [live.brand, model, live.capacity, live.colour, live.grade]
                .map((x) => (x != null ? String(x).trim() : ''))
                .filter(Boolean);
            if (parts.length > 0) live.name = parts.join(' ').replace(/\s+/g, ' ').toUpperCase();
        }
    }

    if (apply && restored.length > 0) {
        purchase.markModified('items');
        await purchase.save();
    }

    return {
        success: true,
        message: apply
            ? `Restored brandModel on ${restored.length} item(s); ${skipped.length} could not be recovered`
            : `Dry-run: would restore ${restored.length}; skip ${skipped.length}`,
        purchaseId: String(purchase._id),
        restored,
        skipped,
        applied: !!apply,
        snapshotCount: snapshots.length,
    };
}

module.exports = {
    restorePurchaseBrandModels,
    pickModel,
    inferModelFromProductName,
    upsertBrandModelVariant,
};
