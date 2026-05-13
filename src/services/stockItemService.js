/**
 * Maintains the StockItem collection (denormalized inventory index) in sync
 * with Purchase + SoldSerial events. Source of truth remains Purchase + SoldSerial;
 * StockItem is a fast read model only.
 *
 * Public surface:
 *   - rebuildForPurchase(purchaseDoc)     — replace all StockItem rows for a purchase
 *   - removeForPurchase(purchaseId)       — drop all rows for a purchase
 *   - markSold(serialNumbers, sale)       — flip serial rows to status='sold'
 *   - markInStock(serialNumbers)          — revert (used on void / sale-return)
 *   - decrementNonSerialQty(...) / incrementNonSerialQty(...) — non-serial qty deltas
 */
const StockItem = require('../models/StockItem');
const Category = require('../models/Category');

/** Build the lowercased searchText blob used by typeahead regex/$text. */
function buildSearchText(parts) {
    return parts
        .map((p) => (p == null ? '' : String(p)).trim())
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

/** Resolve a category reference (ObjectId or populated object) to { id, name }. */
async function resolveCategory(category, categoryNameCache) {
    if (!category) return { id: null, name: '' };
    if (typeof category === 'object' && category._id != null) {
        return { id: category._id, name: String(category.name || '').trim() };
    }
    const id = category;
    const key = String(id);
    if (categoryNameCache && categoryNameCache.has(key)) {
        return { id, name: categoryNameCache.get(key) };
    }
    const cat = await Category.findById(id).select('name').lean().catch(() => null);
    const name = cat ? String(cat.name || '').trim() : '';
    if (categoryNameCache) categoryNameCache.set(key, name);
    return { id, name };
}

/**
 * Build StockItem rows from a single purchase doc.
 * Returns an array of upsert specs ready to bulkWrite.
 */
async function rowsFromPurchase(purchase) {
    if (!purchase) return [];
    const tenantId = purchase.tenantId || 'default';
    const purchaseId = purchase._id;
    const items = purchase.items || [];
    const inventoryDate = purchase.date || purchase.createdAt || null;
    const currency = purchase.currency || 'GBP';
    const categoryNameCache = new Map();

    const rows = [];
    for (const item of items) {
        const purchaseItemId = item._id;
        if (!purchaseItemId) continue;

        const cat = await resolveCategory(item.category, categoryNameCache);
        const variantValues = Array.isArray(item.variantValues)
            ? item.variantValues
                  .filter((v) => v && (v.slug || v.value))
                  .map((v) => ({ slug: String(v.slug || ''), value: String(v.value || '') }))
            : [];
        const variantValueText = variantValues.map((v) => v.value).join(' ');

        const baseFields = {
            tenantId,
            barcode: String(item.barcode || '').trim(),
            name: String(item.name || '').trim(),
            category: cat.name,
            categoryId: cat.id,
            brand: String(item.brand || '').trim(),
            brandModel: String(item.brandModel || '').trim(),
            capacity: String(item.capacity || '').trim(),
            colour: String(item.colour || '').trim(),
            grade: String(item.grade || '').trim(),
            variantValues,
            salePrice: Number(item.salePrice) || 0,
            purchasePrice: Number(item.purchasePrice) || 0,
            currency,
            purchaseId,
            purchaseItemId,
            inventoryDate,
            sendTo: item.sendTo || null
        };

        const searchText = buildSearchText([
            baseFields.name,
            baseFields.barcode,
            baseFields.brand,
            baseFields.brandModel,
            baseFields.capacity,
            baseFields.colour,
            baseFields.grade,
            baseFields.category,
            variantValueText
        ]);

        const isOther = item.isOtherItem === true;
        const imeis = Array.isArray(item.imeis) ? item.imeis.filter(Boolean) : [];

        if (!isOther && imeis.length > 0) {
            for (const rawImei of imeis) {
                const imei = String(rawImei).trim();
                if (!imei) continue;
                rows.push({
                    ...baseFields,
                    isSerial: true,
                    imei,
                    quantity: 1,
                    searchText: `${searchText} ${imei.toLowerCase()}`,
                    status: 'in_stock'
                });
            }
        } else {
            rows.push({
                ...baseFields,
                isSerial: false,
                imei: null,
                quantity: Number(item.quantity) || 1,
                searchText,
                status: 'in_stock'
            });
        }
    }
    return rows;
}

/**
 * Replace all StockItem rows for a purchase.
 * Strategy: delete existing rows for that purchase, then insertMany the new set.
 * Wrapped in try/catch — failures are logged but never block the caller; a
 * subsequent backfill run heals any drift.
 */
async function rebuildForPurchase(purchase) {
    if (!purchase || !purchase._id) return;
    try {
        const rows = await rowsFromPurchase(purchase);
        await StockItem.deleteMany({ tenantId: purchase.tenantId, purchaseId: purchase._id });
        if (rows.length > 0) {
            await StockItem.insertMany(rows, { ordered: false }).catch((err) => {
                // Duplicate-key races during bulk are non-fatal; log and continue.
                if (err && err.code !== 11000) throw err;
            });
        }
    } catch (err) {
        console.error('[stockItemService.rebuildForPurchase] failed:', err.message);
    }
}

async function removeForPurchase(tenantId, purchaseId) {
    if (!purchaseId) return;
    try {
        await StockItem.deleteMany({ tenantId: tenantId || 'default', purchaseId });
    } catch (err) {
        console.error('[stockItemService.removeForPurchase] failed:', err.message);
    }
}

/**
 * Mark serial rows sold in bulk. Idempotent — running twice is fine.
 * @param {string[]} serialNumbers
 * @param {{ saleId, customerName, saleReference, tenantId }} saleMeta
 */
async function markSold(serialNumbers, saleMeta) {
    if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) return;
    const trimmed = [...new Set(serialNumbers.map((s) => String(s).trim()).filter(Boolean))];
    if (trimmed.length === 0) return;
    try {
        await StockItem.updateMany(
            { tenantId: saleMeta.tenantId || 'default', imei: { $in: trimmed } },
            {
                $set: {
                    status: 'sold',
                    saleId: saleMeta.saleId || null,
                    customerName: saleMeta.customerName || '',
                    saleReference: saleMeta.saleReference || '',
                    soldAt: new Date()
                }
            }
        );
    } catch (err) {
        console.error('[stockItemService.markSold] failed:', err.message);
    }
}

async function markInStock(serialNumbers, tenantId) {
    if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) return;
    const trimmed = [...new Set(serialNumbers.map((s) => String(s).trim()).filter(Boolean))];
    if (trimmed.length === 0) return;
    try {
        await StockItem.updateMany(
            { tenantId: tenantId || 'default', imei: { $in: trimmed } },
            {
                $set: {
                    status: 'in_stock',
                    saleId: null,
                    customerName: '',
                    saleReference: '',
                    soldAt: null
                }
            }
        );
    } catch (err) {
        console.error('[stockItemService.markInStock] failed:', err.message);
    }
}

async function decrementNonSerialQty(tenantId, purchaseId, purchaseItemId, delta) {
    if (!purchaseItemId || !delta) return;
    try {
        await StockItem.updateOne(
            { tenantId: tenantId || 'default', purchaseId, purchaseItemId, isSerial: false },
            { $inc: { quantity: -Number(delta) } }
        );
    } catch (err) {
        console.error('[stockItemService.decrementNonSerialQty] failed:', err.message);
    }
}

async function incrementNonSerialQty(tenantId, purchaseId, purchaseItemId, delta) {
    return decrementNonSerialQty(tenantId, purchaseId, purchaseItemId, -delta);
}

/** Set quantity directly (used by Purchase item PATCH). */
async function setNonSerialQty(tenantId, purchaseId, purchaseItemId, quantity) {
    try {
        await StockItem.updateOne(
            { tenantId: tenantId || 'default', purchaseId, purchaseItemId, isSerial: false },
            { $set: { quantity: Number(quantity) || 0 } }
        );
    } catch (err) {
        console.error('[stockItemService.setNonSerialQty] failed:', err.message);
    }
}

module.exports = {
    rowsFromPurchase,
    rebuildForPurchase,
    removeForPurchase,
    markSold,
    markInStock,
    decrementNonSerialQty,
    incrementNonSerialQty,
    setNonSerialQty,
    buildSearchText
};
