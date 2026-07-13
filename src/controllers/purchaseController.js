const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const StockItem = require('../models/StockItem');
const ProductGroupPrice = require('../models/ProductGroupPrice');
const VariantGroupPrice = require('../models/VariantGroupPrice');
const Category = require('../models/Category');
const { buildVariantKey } = require('../utils/variantKeyUtils');
const InventorySettings = require('../models/InventorySettings');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const LedgerEntry = require('../models/LedgerEntry');
const asyncHandler = require('../middleware/asyncHandler');
const auditService = require('../services/auditService');
const activityLogService = require('../services/activityLogService');
const serialIndexService = require('../services/serialIndexService');
const stockItemService = require('../services/stockItemService');
const { getTenantIdFromReq } = require('../middleware/auth');
const {
    distinctSerialNumbersSoldOnActiveSales,
    findActiveSoldSerialsAmong,
} = require('../utils/activeSoldSerialQueries');
const { purchasePartyLabel } = require('../utils/supplierDisplay');
const { normalizePurchaseItems } = require('../utils/normalizePurchaseItems');
const { formatProductName } = require('../utils/formatProductName');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

// ── In-memory cache for forSales endpoint (stale-while-revalidate, 30s TTL) ──
const _forSalesCache = new Map();
const FOR_SALES_CACHE_TTL = 30_000;

function _fsCacheKey(tenantId, locationId, pricingGroupId) {
    return `${tenantId}|${locationId || ''}|${pricingGroupId || ''}`;
}

function _fsCacheGet(key) {
    const entry = _forSalesCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > FOR_SALES_CACHE_TTL) { _forSalesCache.delete(key); return null; }
    return entry.data;
}

function _fsCacheSet(key, data) {
    _forSalesCache.set(key, { data, ts: Date.now() });
    // Evict expired entries when map grows large
    if (_forSalesCache.size > 200) {
        const now = Date.now();
        for (const [k, v] of _forSalesCache) { if (now - v.ts > FOR_SALES_CACHE_TTL) _forSalesCache.delete(k); }
    }
}

/** Invalidate forSales cache for a tenant (call after purchase create/update/delete or stock-changing sales/invoices) */
function invalidateForSalesCache(tenantId) {
    for (const [k] of _forSalesCache) { if (k.startsWith(tenantId + '|')) _forSalesCache.delete(k); }
}

/** Clear create-sales / create-invoice product list caches after any stock mutation. */
async function invalidateInventoryListCaches(tenantId) {
    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    exports.invalidateStockPurchasesCache(tenantId);
    await cache.bumpMany(['purchases:list'], tenantId);
}

/**
 * Validate that barcodes and IMEIs are not already used elsewhere in the system (within same tenant).
 * Returns { valid: false, message } on first conflict, or { valid: true }.
 * @param {Array} items - purchase items with barcode, imeis, isOtherItem
 * @param {string} [excludePurchaseId] - when updating, exclude this purchase from duplicate checks; also allow IMEIs already on this purchase even if sold
 * @param {string} [tenantId] - scope checks to this tenant
 */
async function validateUniqueBarcodeAndImei(items, excludePurchaseId, tenantId) {
    if (!items || items.length === 0) return { valid: true };

    const barcodes = [];
    const imeis = [];
    items.forEach((item) => {
        if (item.isOtherItem && item.barcode) {
            const b = String(item.barcode).trim();
            if (b) barcodes.push(b);
        }
        if (item.imeis && Array.isArray(item.imeis)) {
            item.imeis.forEach((imei) => {
                const s = String(imei).trim();
                if (s) imeis.push(s);
            });
        }
    });

    const tid = tenantId || 'default';
    if (barcodes.length > 0) {
        const uniqueBarcodes = [...new Set(barcodes)];
        const inProduct = await Product.findOne({ tenantId: tid, barcode: { $in: uniqueBarcodes } }).select('barcode').lean();
        if (inProduct) {
            return { valid: false, message: `Barcode "${inProduct.barcode}" already exists in products. Each barcode must be unique.` };
        }
        // Allow reusing a barcode whose stock is fully depleted (items.quantity <= 0) — matches
        // stock-view's "available" filter, otherwise users see "not in stock" but cannot reuse the barcode.
        const purchaseQuery = { tenantId: tid, 'items.barcode': { $in: uniqueBarcodes } };
        if (excludePurchaseId) purchaseQuery._id = { $ne: excludePurchaseId };
        const conflictingPurchases = await Purchase.find(purchaseQuery).select('items.barcode items.quantity items.isOtherItem').lean();
        for (const p of conflictingPurchases) {
            const found = (p.items || []).find((it) => {
                if (!it.barcode || !uniqueBarcodes.includes(String(it.barcode).trim())) return false;
                if (it.isOtherItem) {
                    const q = Number(it.quantity);
                    if (Number.isFinite(q) && q <= 0) return false; // depleted non-serial line — barcode is free
                }
                return true;
            });
            if (found) {
                return { valid: false, message: `Barcode "${found.barcode}" is already used in another parcel. Each barcode must be unique in the system.` };
            }
        }
        const withinSame = barcodes.filter((b, i) => barcodes.indexOf(b) !== i);
        if (withinSame.length > 0) {
            return { valid: false, message: `Duplicate barcode in this parcel: "${withinSame[0]}". Each barcode must be unique.` };
        }
    }

    if (imeis.length > 0) {
        const uniqueImeis = [...new Set(imeis)];
        // When updating, only check SoldSerial for IMEIs that are NEW (not already on this purchase)
        let imeisToCheckSold = uniqueImeis;
        if (excludePurchaseId) {
            const current = await Purchase.findOne({ _id: excludePurchaseId, tenantId: tid }).select('items.imeis').lean();
            const existingOnPurchase = new Set();
            if (current && Array.isArray(current.items)) {
                current.items.forEach((it) => {
                    (it.imeis || []).forEach((s) => {
                        const t = String(s).trim();
                        if (t) existingOnPurchase.add(t);
                    });
                });
            }
            imeisToCheckSold = uniqueImeis.filter((u) => !existingOnPurchase.has(u));
        }
        if (imeisToCheckSold.length > 0) {
            const blocking = await findActiveSoldSerialsAmong(imeisToCheckSold);
            if (blocking.length > 0) {
                const sn = blocking[0].serialNumber;
                return { valid: false, message: `IMEI "${sn}" has already been sold. Each IMEI can only be in the system once.` };
            }
        }
        const purchaseQuery = { tenantId: tid, 'items.imeis': { $in: uniqueImeis } };
        if (excludePurchaseId) purchaseQuery._id = { $ne: excludePurchaseId };
        const existingImei = await Purchase.findOne(purchaseQuery).lean();
        if (existingImei) {
            for (const it of existingImei.items || []) {
                const list = (it.imeis || []).map((s) => String(s).trim());
                const found = uniqueImeis.find((u) => list.includes(u));
                if (found) {
                    return { valid: false, message: `IMEI "${found}" is already used in another parcel. Each IMEI must be unique in the system.` };
                }
            }
        }
        const withinSame = imeis.filter((s, i) => imeis.indexOf(s) !== i);
        if (withinSame.length > 0) {
            return { valid: false, message: `Duplicate IMEI in this parcel: "${withinSame[0]}". Each IMEI must be unique.` };
        }
    }

    return { valid: true };
}

/** Keep first non-serial line per trimmed barcode; drop later duplicates (import / API safety). */
function dedupeOtherItemsByBarcodeKeepingFirst(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const seen = new Set();
    return items.filter((it) => {
        if (!it || !it.isOtherItem) return true;
        const b = it.barcode != null ? String(it.barcode).trim() : '';
        if (!b) return true;
        if (seen.has(b)) return false;
        seen.add(b);
        return true;
    });
}

/** Align parcel totals with current items (after dedupe or edits). */
function recomputePurchaseAggregatesFromItems(body) {
    const items = body.items || [];
    let otherQty = 0;
    let imeiQty = 0;
    let grandTotal = 0;
    for (const it of items) {
        if (it.isOtherItem) {
            const q = Number(it.quantity);
            const qty = Number.isFinite(q) && q > 0 ? q : 1;
            otherQty += qty;
            grandTotal += (Number(it.purchasePrice) || 0) * qty;
        } else {
            const n = Array.isArray(it.imeis) ? it.imeis.length : 1;
            imeiQty += n;
            grandTotal += (Number(it.purchasePrice) || 0) * n;
        }
    }
    body.otherQuantity = otherQty;
    body.totalOtherQuantity = otherQty;
    body.imeiQuantity = imeiQty;
    body.totalIMEIs = imeiQty;
    body.grandTotal = grandTotal;
}

// Same order as when saving: brand → model → then other attributes (fetch returns data in this order)
const VARIANT_SLUG_ORDER = ['brands', 'brand', 'brands_model', 'brand_model', 'make', 'grade', 'storage', 'capacity', 'color', 'colour', 'condition'];
const variantSlugRank = (slug) => {
    const i = VARIANT_SLUG_ORDER.indexOf((slug || '').toLowerCase());
    return i === -1 ? VARIANT_SLUG_ORDER.length : i;
};

/** Ensure each item's variantValues array is returned in the same loop order (brand → model → …) */
function sortPurchaseItemsVariantValues(purchase) {
    if (!purchase) return purchase;
    const doc = purchase.toObject ? purchase.toObject() : { ...purchase };
    if (Array.isArray(doc.items)) {
        doc.items = doc.items.map((item) => {
            const it = { ...item };
            if (Array.isArray(it.variantValues) && it.variantValues.length > 0) {
                it.variantValues = [...it.variantValues].sort(
                    (a, b) => variantSlugRank(a.slug) - variantSlugRank(b.slug)
                );
            }
            return it;
        });
    }
    return doc;
}

/** Sort variantValues for a single purchase or array of purchases */
function normalizePurchasesForResponse(data) {
    if (Array.isArray(data)) {
        return data.map((p) => sortPurchaseItemsVariantValues(p));
    }
    return sortPurchaseItemsVariantValues(data);
}
// @desc    Find in-stock product by serial/IMEI (for POS search). Uses SerialIndex + Redis when available.
// @route   GET /api/purchases/find-in-stock-serial/:serial
// @access  Private
// Uses request tenant (getTenantIdFromReq) so single-tenant stays 'default', multi-tenant is correct.
// Per-serial response cache (3s TTL) — collapses repeated scans / quick re-clicks.
const _findInStockCache = new Map();
const FIND_IN_STOCK_TTL = 3_000;
function _fisKey(tenantId, serial, pricingGroupId) {
    return `${tenantId}|${serial}|${pricingGroupId || ''}`;
}
function _fisGet(key) {
    const e = _findInStockCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > FIND_IN_STOCK_TTL) { _findInStockCache.delete(key); return null; }
    return e.payload;
}
function _fisSet(key, payload) {
    _findInStockCache.set(key, { payload, ts: Date.now() });
    if (_findInStockCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of _findInStockCache) { if (now - v.ts > FIND_IN_STOCK_TTL) _findInStockCache.delete(k); }
    }
}

exports.getFindInStockSerial = asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const raw = (req.params.serial || '').trim();
    if (!raw) {
        return res.status(400).json({ success: false, message: 'Serial number is required' });
    }
    const tenantId = getTenantIdFromReq(req) || 'default';
    const pricingGroupId = req.query.pricingGroupId || null;
    const normalized = serialIndexService.normalizeSerial(raw) || raw;

    const cacheKey = _fisKey(tenantId, normalized, pricingGroupId);
    const cached = _fisGet(cacheKey);
    if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(cached.status).json(cached.body);
    }

    const respond = (status, body) => {
        // Only cache positive/negative-stable answers (skip 4xx errors that depend on transient state)
        if (status === 200 || status === 404) _fisSet(cacheKey, { status, body });
        res.setHeader('Server-Timing', `total;dur=${Date.now() - t0}`);
        return res.status(status).json(body);
    };

    // Index + Redis first (same as batch endpoint). Legacy Purchase scan is expensive;
    // only run it on index miss, sold reconcile, or when group pricing needs full variant fields.
    const { results: indexResults } = await serialIndexService.lookupSerials(tenantId, [normalized]);
    const indexOne = indexResults && indexResults[0];

    if (indexOne?.status === 'in_stock' && indexOne.product && !pricingGroupId) {
        return respond(200, { success: true, data: indexOne.product });
    }
    if (indexOne?.status === 'returned_to_supplier') {
        return respond(404, { success: false, message: 'Serial was returned to supplier and is not available to sell' });
    }

    const needsLegacy =
        !indexOne ||
        indexOne.status === 'not_found' ||
        indexOne.status === 'already_sold' ||
        (indexOne.status === 'in_stock' && (!indexOne.product || !!pricingGroupId));

    let one = indexOne;
    if (needsLegacy) {
        const legacyResults = await legacyFindInStockSerials([normalized], tenantId);
        const legacyOne = legacyResults && legacyResults[0];
        // Reconcile: legacy wins for `in_stock` (full variant + latest sale price).
        // Index wins for `already_sold` when legacy agrees (voided sale may flip to in_stock).
        if (legacyOne && legacyOne.status === 'in_stock') {
            one = legacyOne;
            if (!indexOne || indexOne.status !== legacyOne.status || !indexOne.product) {
                serialIndexService.upsertFromResult(tenantId, legacyOne).catch(() => {});
            }
        } else if (indexOne && indexOne.status === 'already_sold' && (!legacyOne || legacyOne.status === 'already_sold' || legacyOne.status === 'not_found')) {
            one = indexOne;
        } else if (legacyOne) {
            one = legacyOne;
            if (indexOne && indexOne.status !== legacyOne.status) {
                serialIndexService.upsertFromResult(tenantId, legacyOne).catch(() => {});
            }
        }
    }

    if (one) {
        if (one.status === 'in_stock' && one.product) {
            // Apply pricing group when set: VariantGroupPrice → ProductGroupPrice → leave as-is.
            if (pricingGroupId) {
                const p = one.product;
                const variantKey = buildVariantKey(p.category, p.grade, p.brand, p.brandModel, p.capacity);
                if (variantKey) {
                    const vgp = await VariantGroupPrice.findOne({ tenantId, pricingGroup: pricingGroupId, variantKey }).select('price').lean();
                    if (vgp != null && vgp.price != null) {
                        one.product.price = Number(vgp.price);
                        return respond(200, { success: true, data: one.product });
                    }
                }
                if (p.barcode) {
                    const priceMap = await resolvePricesByBarcodes([p.barcode], tenantId, pricingGroupId);
                    const resolved = priceMap.get(String(p.barcode).trim());
                    if (resolved != null) one.product.price = resolved;
                }
            }
            return respond(200, { success: true, data: one.product });
        }
        if (one.status === 'already_sold') {
            return respond(404, {
                success: false,
                message: 'Serial already sold',
                status: 'already_sold',
                soldInfo: one.soldInfo || null,
            });
        }
        if (one.status === 'returned_to_supplier') {
            return respond(404, { success: false, message: 'Serial was returned to supplier and is not available to sell' });
        }
    }
    return respond(404, { success: false, message: 'Serial not found in inventory' });
});

/**
 * Resolve selling price by barcode for a pricing group. Returns map barcode -> price.
 * Used by find-in-stock serial endpoints when pricingGroupId is set.
 */
async function resolvePricesByBarcodes(barcodes, tenantId, pricingGroupId) {
    const map = new Map();
    if (!pricingGroupId || !tenantId || !barcodes || barcodes.length === 0) return map;
    const unique = [...new Set(barcodes.filter(Boolean).map((b) => String(b).trim()).filter(Boolean))];
    if (unique.length === 0) return map;
    const products = await Product.find({ tenantId, barcode: { $in: unique } }).select('_id barcode sellingPrice').lean();
    const productIds = products.map((p) => p._id);
    const groupPrices = await ProductGroupPrice.find({ tenantId, pricingGroup: pricingGroupId, product: { $in: productIds } }).lean();
    const productIdToPrice = {};
    groupPrices.forEach((gp) => { productIdToPrice[gp.product.toString()] = Number(gp.price); });
    products.forEach((p) => {
        const b = (p.barcode && String(p.barcode).trim()) || '';
        if (!b) return;
        const groupPrice = productIdToPrice[p._id.toString()];
        const resolved = (groupPrice != null && !Number.isNaN(groupPrice)) ? groupPrice : (Number(p.sellingPrice) || 0);
        map.set(b, resolved);
    });
    return map;
}

// Helper: build product payload for one serial from a purchase item (same shape as getFindInStockSerial)
function buildInStockProductFromItem(purchase, item, itemIndex, serial) {
    const it = item;
    const categoryName = (it.category && it.category.name) ? it.category.name : (it.category && typeof it.category === 'string') ? it.category : '';
    let grade = (it.grade != null && String(it.grade).trim()) ? String(it.grade).trim() : '';
    if (!grade && Array.isArray(it.variantValues)) {
        const entry = it.variantValues.find((e) => ((e.slug || '').toLowerCase() === 'grade' || (e.slug || '').toLowerCase() === 'condition') && e.value);
        if (entry) grade = String(entry.value).trim();
    }
    if (!grade && it.name && String(it.name).trim()) {
        const nameStr = String(it.name).trim();
        const gradeMatch = nameStr.match(/\b(GRADE\s+[A-Z0-9\-]+(?:\s*-\s*[A-Z\s]+)?|Grade\s+[A-Za-z0-9\-]+|[A-Z]\s*-\s*[A-Z\s]+)\b/i);
        if (gradeMatch) grade = gradeMatch[1].trim();
    }
    const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
    const name = parts.length > 0 ? parts.join(' ') : ((it.name && it.name.trim()) ? it.name.trim() : 'Product');
    const itemId = it._id ? it._id.toString() : `item-${itemIndex}`;
    const sku = `${purchase._id}-${itemId}`;
    return {
        sku,
        name,
        price: Number(it.salePrice) || 0,
        category: categoryName || 'Uncategorized',
        brand: it.brand || '',
        colour: it.colour || '',
        grade: grade || '',
        brandModel: it.brandModel || '',
        capacity: it.capacity || '',
        serial,
        barcode: (it.barcode && String(it.barcode).trim()) || undefined,
        purchaseId: purchase._id.toString(),
        purchaseItemId: it._id ? it._id.toString() : itemId,
        purchaseDate: (purchase.createdAt || purchase.date || new Date()).toISOString(),
        unitCost: Number(it.purchasePrice) ?? null
    };
}

// Legacy path: SoldSerial + SerialHistory + Purchase scan (used when SerialIndex misses). Scoped by tenantId.
async function legacyFindInStockSerials(serials, tenantId) {
    if (!serials || serials.length === 0) return [];
    const tid = tenantId || 'default';
    const toProcess = serials.slice(0, 500);
    const [soldDocs, returnedHistory, returnedSold] = await Promise.all([
        SoldSerial.find({ serialNumber: { $in: toProcess }, status: { $ne: 'returned' } }).select('serialNumber').populate('saleId', 'reference customerName status').lean(),
        SerialHistory.find({ serialNumber: { $in: toProcess }, eventType: 'returned_to_supplier' }).select('serialNumber').lean(),
        SoldSerial.find({ serialNumber: { $in: toProcess }, status: 'returned', returnDestination: 'return_to_supplier' }).select('serialNumber').lean(),
    ]);
    const soldDocsActive = soldDocs.filter((d) => d.saleId && d.saleId.status !== 'voided');
    const soldSet = new Set(soldDocsActive.map((d) => d.serialNumber));
    const soldInfoMap = {};
    soldDocsActive.forEach((d) => {
        if (d.serialNumber && d.saleId) {
            soldInfoMap[d.serialNumber] = { reference: d.saleId.reference, customerName: d.saleId.customerName };
        }
    });
    const returnedSet = new Set([
        ...(returnedHistory || []).map((d) => d.serialNumber),
        ...(returnedSold || []).map((d) => d.serialNumber),
    ].filter(Boolean));
    const availableSerials = toProcess.filter((s) => !soldSet.has(s) && !returnedSet.has(s));
    const results = [];
    for (const serial of toProcess) {
        if (soldSet.has(serial)) {
            results.push({ serial, status: 'already_sold', soldInfo: soldInfoMap[serial] || null });
            continue;
        }
        if (returnedSet.has(serial)) {
            results.push({ serial, status: 'returned_to_supplier' });
            continue;
        }
        results.push({ serial, status: 'pending' });
    }
    if (availableSerials.length > 0) {
        // Project only the fields needed by buildInStockProductFromItem; skip heavy fields
        // (note, supplier, account, totals, etc.). Uses tenantId+items.imeis multikey index.
        const purchases = await Purchase.find(
            { tenantId: tid, 'items.imeis': { $in: availableSerials } },
            {
                _id: 1, currency: 1, date: 1, createdAt: 1,
                'items._id': 1,
                'items.name': 1,
                'items.barcode': 1,
                'items.category': 1,
                'items.grade': 1,
                'items.brand': 1,
                'items.brandModel': 1,
                'items.capacity': 1,
                'items.colour': 1,
                'items.variantValues': 1,
                'items.purchasePrice': 1,
                'items.salePrice': 1,
                'items.imeis': 1,
                'items.imeiSerials': 1,
                'items.serialItemIdNumber': 1,
                'items.isOtherItem': 1,
            }
        )
            .populate('items.category', 'name')
            .lean();
        // O(serials) Set lookup replaces the prior O(purchases × items × serials) triple loop.
        // Walk imeis once per item; cheap Set.has check identifies matches.
        const wantedSet = new Set(availableSerials);
        const serialToBest = {};
        for (const p of purchases) {
            const items = p.items || [];
            const purchaseDate = (p.createdAt || p.date || new Date()).toISOString();
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const imeis = Array.isArray(it.imeis) ? it.imeis : [];
                if (imeis.length === 0) continue;
                const salePrice = Number(it.salePrice) || 0;
                for (let k = 0; k < imeis.length; k++) {
                    const serial = String(imeis[k]).trim();
                    if (!wantedSet.has(serial)) continue;
                    const existing = serialToBest[serial];
                    const useThis = !existing || salePrice > existing.price || (salePrice === existing.price && purchaseDate > existing.purchaseDate);
                    if (useThis) {
                        serialToBest[serial] = buildInStockProductFromItem(p, it, i, serial);
                    }
                }
            }
        }
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'pending') {
                const serial = results[i].serial;
                const product = serialToBest[serial];
                results[i] = product ? { serial, status: 'in_stock', product } : { serial, status: 'not_found' };
            }
        }
    }
    return results;
}

// @desc    Batch find in-stock products by serial/IMEI (for bulk add to cart)
// @route   POST /api/purchases/find-in-stock-serials
// @access  Private
exports.getFindInStockSerialsBatch = asyncHandler(async (req, res) => {
    const serials = Array.isArray(req.body.serials) ? req.body.serials : [];
    const normalized = serials.map((s) => serialIndexService.normalizeSerial(s)).filter(Boolean);
    const unique = [...new Set(normalized)];
    if (unique.length === 0) {
        return res.status(200).json({ success: true, data: { results: [] } });
    }
    const MAX_BATCH = 500;
    const toProcess = unique.length > MAX_BATCH ? unique.slice(0, MAX_BATCH) : unique;
    const tenantId = getTenantIdFromReq(req);

    const { results, cacheHits, cacheMisses, dbTimeMs, totalTimeMs } = await serialIndexService.lookupSerials(tenantId, toProcess);

    const reconcileSerials = results.filter((r) => r.status === 'not_found' || r.status === 'already_sold' || (r.status === 'in_stock' && !r.product)).map((r) => r.serial);
    if (reconcileSerials.length > 0) {
        const legacyResults = await legacyFindInStockSerials(reconcileSerials, tenantId);
        const bySerial = {};
        legacyResults.forEach((r) => { bySerial[r.serial] = r; });
        for (let i = 0; i < results.length; i++) {
            const st = results[i].status;
            if ((st === 'not_found' || st === 'already_sold' || (st === 'in_stock' && !results[i].product)) && bySerial[results[i].serial]) {
                const leg = bySerial[results[i].serial];
                results[i] = leg;
                serialIndexService.upsertFromResult(tenantId, leg).catch(() => {});
            }
        }
    }

    const pricingGroupId = req.body.pricingGroupId || null;
    if (pricingGroupId) {
        const inStockSerials = results.filter((r) => r.status === 'in_stock' && r.product).map((r) => r.serial);
        let legacyBySerial = {};
        if (inStockSerials.length > 0) {
            const legacyResults = await legacyFindInStockSerials(inStockSerials, tenantId);
            legacyResults.forEach((r) => {
                if (r.status === 'in_stock' && r.product) legacyBySerial[r.serial] = r.product;
            });
        }
        results.forEach((r) => {
            if (r.status === 'in_stock' && r.product && legacyBySerial[r.serial]) {
                r.product = legacyBySerial[r.serial];
            }
        });
        const variantKeys = new Set();
        results.forEach((r) => {
            if (r.status === 'in_stock' && r.product) {
                const p = r.product;
                const vk = buildVariantKey(p.category, p.grade, p.brand, p.brandModel, p.capacity);
                if (vk) variantKeys.add(vk);
            }
        });
        let variantKeyToPrice = {};
        if (variantKeys.size > 0) {
            const variantPrices = await VariantGroupPrice.find({ tenantId, pricingGroup: pricingGroupId, variantKey: { $in: [...variantKeys] } }).select('variantKey price').lean();
            variantPrices.forEach((v) => { variantKeyToPrice[v.variantKey] = Number(v.price); });
        }
        const barcodes = results.filter((r) => r.status === 'in_stock' && r.product && r.product.barcode).map((r) => r.product.barcode);
        const barcodePriceMap = barcodes.length > 0 ? await resolvePricesByBarcodes(barcodes, tenantId, pricingGroupId) : new Map();
        results.forEach((r) => {
            if (r.status !== 'in_stock' || !r.product) return;
            const p = r.product;
            const vk = buildVariantKey(p.category, p.grade, p.brand, p.brandModel, p.capacity);
            if (vk && variantKeyToPrice[vk] != null) {
                r.product.price = variantKeyToPrice[vk];
                return;
            }
            if (p.barcode) {
                const resolved = barcodePriceMap.get(String(p.barcode).trim());
                if (resolved != null) r.product.price = resolved;
            }
        });
    }

    if (process.env.NODE_ENV !== 'test') {
        console.info('[find-in-stock-serials]', { cacheHits, cacheMisses, dbTimeMs, totalTimeMs, n: toProcess.length });
    }

    res.status(200).json({ success: true, data: { results } });
});


/** Build variant key from purchase item (uses shared buildVariantKey; category may be populated). */
function buildVariantKeyFromItem(item) {
    const getCatName = (c) => {
        if (!c) return '';
        if (typeof c === 'object' && c && c.name) return String(c.name).trim();
        return String(c).trim();
    };
    return buildVariantKey(
        getCatName(item.category),
        item.grade,
        item.brand,
        item.brandModel,
        item.capacity
    );
}

/**
 * Apply customer group pricing to purchase items when forSales and pricingGroupId are set.
 * Resolves price: (1) VariantGroupPrice by variantKey (category+grade+brand+model+capacity); (2) else ProductGroupPrice/Product.sellingPrice by barcode; (3) else item.salePrice.
 * Mutates data in place.
 */
async function resolveGroupPricesForPurchases(data, tenantId, pricingGroupId) {
    if (!pricingGroupId || !tenantId || !Array.isArray(data)) return;
    const variantKeys = new Set();
    data.forEach((p) => {
        (p.items || []).forEach((it) => {
            const key = buildVariantKeyFromItem(it);
            if (key) variantKeys.add(key);
        });
    });
    let variantKeyToPrice = {};
    if (variantKeys.size > 0) {
        const variantPrices = await VariantGroupPrice.find({
            tenantId,
            pricingGroup: pricingGroupId,
            variantKey: { $in: [...variantKeys] }
        }).select('variantKey price').lean();
        variantPrices.forEach((v) => { variantKeyToPrice[v.variantKey] = Number(v.price); });
    }
    const barcodes = [];
    data.forEach((p) => {
        (p.items || []).forEach((it) => {
            const b = (it.barcode && String(it.barcode).trim()) || null;
            if (b) barcodes.push(b);
        });
    });
    const uniqueBarcodes = [...new Set(barcodes)];
    let barcodeToResolvedPrice = {};
    if (uniqueBarcodes.length > 0) {
        const products = await Product.find({ tenantId, barcode: { $in: uniqueBarcodes } }).select('_id barcode sellingPrice').lean();
        const productIds = products.map((p) => p._id);
        const groupPrices = await ProductGroupPrice.find({ tenantId, pricingGroup: pricingGroupId, product: { $in: productIds } }).lean();
        const productIdToGroupPrice = {};
        groupPrices.forEach((gp) => { productIdToGroupPrice[gp.product.toString()] = Number(gp.price); });
        products.forEach((p) => {
            const bid = (p.barcode && String(p.barcode).trim()) || '';
            if (!bid) return;
            const groupPrice = productIdToGroupPrice[p._id.toString()];
            barcodeToResolvedPrice[bid] = (groupPrice != null && !Number.isNaN(groupPrice)) ? groupPrice : (Number(p.sellingPrice) || 0);
        });
    }
    data.forEach((p) => {
        (p.items || []).forEach((it) => {
            const vk = buildVariantKeyFromItem(it);
            if (vk && variantKeyToPrice[vk] != null) {
                it.salePrice = variantKeyToPrice[vk];
                return;
            }
            const b = (it.barcode && String(it.barcode).trim()) || null;
            if (b && barcodeToResolvedPrice[b] != null) {
                it.salePrice = barcodeToResolvedPrice[b];
            }
        });
    });
}

/** Escape special chars for use in RegExp */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build $or conditions for purchase list search (reference, supplier company name, contact name). */
async function buildPurchaseListSearchOr(searchTerm) {
    const trimmed = String(searchTerm || '').trim();
    if (!trimmed) return null;
    const regex = { $regex: escapeRegex(trimmed), $options: 'i' };
    const orConditions = [
        { purchaseNumber: regex },
        { parcelNumber: regex },
    ];

    const [suppliers, customers] = await Promise.all([
        Supplier.find({
            $or: [{ name: regex }, { contactPerson: regex }],
        }).select('_id').lean(),
        Customer.find({
            $or: [{ name: regex }, { contactName: regex }],
        }).select('_id').lean(),
    ]);

    const supplierIds = suppliers.map((s) => s._id);
    const customerIds = customers.map((c) => c._id);

    if (supplierIds.length > 0) {
        orConditions.push({ supplier: { $in: supplierIds } });
    }
    const accountIds = [...supplierIds, ...customerIds];
    if (accountIds.length > 0) {
        orConditions.push({ account: { $in: accountIds } });
    }

    return orConditions;
}

// @route   GET /api/purchases
// @access  Private
exports.getPurchases = asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);

    // Redis-backed list cache (only for non-forSales path; forSales has its own in-memory cache below).
    // NOTE: this short-circuits before in-memory caches/SWR — both pathways are invalidated together
    // via cache.bumpNs('purchases:list') and invalidateForSalesCache() on every mutation.
    const _redisListParams = {
        page, limit,
        status: req.query.status || null,
        paymentStatus: req.query.paymentStatus || null,
        completionStatus: req.query.completionStatus || null,
        search: req.query.search || null,
        sort: req.query.sort || null,
        excludeSold: req.query.excludeSold === 'true',
        locationId: req.query.locationId || null,
        pricingGroupId: req.query.pricingGroupId || null,
    };

    const query = { tenantId };

    if (req.query.status) {
        query.status = req.query.status;
    }

    if (req.query.paymentStatus) {
        query.paymentStatus = req.query.paymentStatus;
    }

    if (req.query.completionStatus) {
        query.completionStatus = req.query.completionStatus;
    }

    if (req.query.search) {
        const searchOr = await buildPurchaseListSearchOr(req.query.search);
        if (searchOr) {
            query.$or = searchOr;
        }
    }

    // When forSales=1 (create-sales non-serial grid), only load purchases that have at least one non-serial item — much faster.
    const forSales = req.query.forSales === '1';
    if (forSales) {
        query.items = {
            $elemMatch: {
                $or: [
                    { isOtherItem: true },
                    { imeis: { $exists: true, $size: 0 } },
                    { imeis: { $exists: false } }
                ]
            }
        };
    }

    // ── forSales in-memory cache (30s TTL): return cached response instantly ──
    const locationId = req.query.locationId || null;
    const pricingGroupId = req.query.pricingGroupId || null;
    if (forSales) {
        const cKey = _fsCacheKey(tenantId, locationId, pricingGroupId);
        const cached = _fsCacheGet(cKey);
        if (cached) {
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Server-Timing', 'total;dur=0');
            return res.status(200).json(cached);
        }
    }

    // Sorting
    let sortOption = '-createdAt';
    if (req.query.sort === 'oldest') sortOption = 'createdAt';
    else if (req.query.sort === 'latest') sortOption = '-createdAt';

    const excludeSold = req.query.excludeSold === 'true';

    // Redis-backed list cache for the non-forSales index path only.
    // The forSales path keeps its in-memory cache above (faster + already tenant-scoped); both are bumped on mutations.
    if (!forSales) {
        const cachedResponse = await cache.cached(
            { ns: 'purchases:list', tenantId, params: _redisListParams, ttlSec: TTL.TRANSACTIONAL },
            async () => {
                const purchaseQueryInner = Purchase.find(query)
                    .skip(startIndex)
                    .limit(limit)
                    .sort(sortOption)
                    .populate('supplier', 'name contactPerson')
                    .populate('account')
                    .populate('createdBy', 'name')
                    .populate('items.sendTo', 'name')
                    .populate('items.tax', 'name rate type')
                    .populate('items.category', 'name')
                    .populate('items.subCategory', 'name')
                    .lean();
                const soldPromiseInner = excludeSold ? distinctSerialNumbersSoldOnActiveSales() : Promise.resolve([]);
                const [totalInner, purchasesInner, soldSerialsInner] = await Promise.all([
                    Purchase.countDocuments(query),
                    purchaseQueryInner,
                    soldPromiseInner
                ]);
                let dataInner = normalizePurchasesForResponse(purchasesInner);
                if (excludeSold && Array.isArray(soldSerialsInner)) {
                    const soldSet = new Set(soldSerialsInner.map((s) => String(s).trim()));
                    dataInner = dataInner.map((p) => {
                        const filteredItems = (p.items || [])
                            .map((it) => ({
                                ...it,
                                imeis: (it.imeis || []).filter((imei) => !soldSet.has(String(imei).trim()))
                            }))
                            .filter((it) => (it.imeis || []).length > 0 || it.isOtherItem === true);
                        return { ...p, items: filteredItems };
                    });
                }
                if (locationId) {
                    dataInner = dataInner.map((p) => {
                        const filteredItems = (p.items || []).filter((it) => {
                            const sendTo = it.sendTo;
                            // Items without sendTo are unassigned — visible at every location (e.g. import omitting location).
                            if (!sendTo) return true;
                            const id = typeof sendTo === 'object' ? String(sendTo._id) : String(sendTo);
                            return id === locationId;
                        });
                        return { ...p, items: filteredItems };
                    }).filter((p) => (p.items || []).length > 0);
                }
                return {
                    success: true,
                    count: dataInner.length,
                    total: totalInner,
                    page,
                    pages: Math.ceil(totalInner / limit) || 1,
                    data: dataInner
                };
            }
        );
        const tEnd = Date.now();
        res.setHeader('Server-Timing', `total;dur=${tEnd - t0}`);
        return res.status(200).json(cachedResponse);
    }

    // ── forSales fast path: skip countDocuments (frontend loads all, doesn't paginate) ──
    // and use SoldSerial.distinct() instead of aggregation+$lookup when no voided sales exist.
    const soldPromise = excludeSold ? distinctSerialNumbersSoldOnActiveSales() : Promise.resolve([]);

    const purchaseQuery = Purchase.find(query)
        .skip(startIndex)
        .limit(limit)
        .sort(sortOption);
    if (forSales) {
        // For create-sales: select only needed fields (skip supplier, account, note, totals, etc.) and populate minimal refs
        purchaseQuery
            .select('_id currency date items')
            .populate('items.category', 'name')
            .populate('items.sendTo', 'name type')
            .lean();
    } else {
        purchaseQuery
            .populate('supplier', 'name contactPerson')
            .populate('account')
            .populate('createdBy', 'name')
            .populate('items.sendTo', 'name')
            .populate('items.tax', 'name rate type')
            .populate('items.category', 'name')
            .populate('items.subCategory', 'name')
            .lean();
    }

    // For forSales, skip the count query (frontend always requests all with limit=2000)
    const tQuery = Date.now();
    const [total, purchases, soldSerials] = await Promise.all([
        forSales ? Promise.resolve(-1) : Purchase.countDocuments(query),
        purchaseQuery,
        soldPromise
    ]);
    const tQueryDone = Date.now();

    // ── DEBUG: supplier population diagnostics (remove after debugging live "—" supplier issue) ──
    if (!forSales) {
        try {
            const Supplier = require('mongoose').model('Supplier');
            const supplierCount = await Supplier.countDocuments({});
            console.log(`[SUPPLIER-DEBUG] tenantId=${tenantId} totalSuppliersInDB=${supplierCount} purchasesReturned=${purchases.length}`);
            for (const p of purchases.slice(0, 5)) {
                const s = p.supplier;
                let kind = 'null/undefined';
                let detail = '';
                if (s && typeof s === 'object') {
                    kind = 'populated-object';
                    detail = `id=${s._id} name=${JSON.stringify(s.name)}`;
                } else if (s) {
                    kind = 'raw-id';
                    detail = `id=${s}`;
                    const exists = await Supplier.exists({ _id: s });
                    detail += ` existsInDB=${!!exists}`;
                }
                console.log(`[SUPPLIER-DEBUG] purchase=${p.purchaseNumber || p._id} supplierField=${kind} ${detail} account=${JSON.stringify(p.account?.name || p.account || null)}`);
            }
        } catch (e) {
            console.log('[SUPPLIER-DEBUG] error:', e.message);
        }
    }

    let data = normalizePurchasesForResponse(purchases);

    // Rigid inventory: exclude IMEIs that have been sold; only in-stock serials appear. Keep non-serial (other) items so they show in inventory and are available to sell.
    if (excludeSold && Array.isArray(soldSerials)) {
        const soldSet = new Set(soldSerials.map((s) => String(s).trim()));
        data = data.map((p) => {
            const filteredItems = (p.items || [])
                .map((it) => ({
                    ...it,
                    imeis: (it.imeis || []).filter((imei) => !soldSet.has(String(imei).trim()))
                }))
                .filter((it) => (it.imeis || []).length > 0 || it.isOtherItem === true);
            return { ...p, items: filteredItems };
        });
    }

    // Location filter: when locationId is provided, only keep items assigned to that location
    if (locationId) {
        data = data.map((p) => {
            const filteredItems = (p.items || []).filter((it) => {
                const sendTo = it.sendTo;
                // Items without sendTo are unassigned — visible at every location (e.g. import omitting location).
                if (!sendTo) return true;
                const id = typeof sendTo === 'object' ? String(sendTo._id) : String(sendTo);
                return id === locationId;
            });
            return { ...p, items: filteredItems };
        }).filter((p) => (p.items || []).length > 0);
    }

    // Customer group pricing: when forSales and pricingGroupId, resolve salePrice per item from ProductGroupPrice or Product.sellingPrice (fallback to item.salePrice if no product match).
    if (forSales && pricingGroupId) {
        await resolveGroupPricesForPurchases(data, tenantId, pricingGroupId);
    }

    const finalTotal = total === -1 ? data.length : total;

    const responseBody = {
        success: true,
        count: data.length,
        total: finalTotal,
        page,
        pages: forSales ? 1 : (Math.ceil(finalTotal / limit) || 1),
        data
    };

    // Store in forSales cache
    if (forSales) {
        const cKey = _fsCacheKey(tenantId, locationId, pricingGroupId);
        _fsCacheSet(cKey, responseBody);
        res.setHeader('X-Cache', 'MISS');
    }

    // Server-Timing header so frontend/devtools can see breakdown
    const tEnd = Date.now();
    res.setHeader('Server-Timing', `db;dur=${tQueryDone - tQuery}, post;dur=${tEnd - tQueryDone}, total;dur=${tEnd - t0}`);

    res.status(200).json(responseBody);
});

/** Max purchases to scan for stock view rows (server-side pagination); avoids loading huge sets */
const STOCK_VIEW_MAX_PURCHASES = 5000;

// ── Stale-while-revalidate (SWR) cache for stock-view ──
// After the first successful fetch per tenant, requests serve cached data immediately.
// Past `freshMs`, data is "stale": served right away but a background refresh kicks off
// so the next request gets fresh data. Past `maxStaleMs`, the cache is dropped and the
// next request waits for a fresh fetch (treated as cold).
//
// Result: only the very first request per tenant per maxStaleMs window is ever slow.
function _makeSwrCache({ freshMs, maxStaleMs }) {
    const store = new Map();
    const inflight = new Map();
    return {
        /** @returns {{ value: any, isStale: boolean } | null} */
        get(key) {
            const e = store.get(key);
            if (!e) return null;
            const age = Date.now() - e.t;
            if (age > maxStaleMs) { store.delete(key); return null; }
            return { value: e.v, isStale: age > freshMs };
        },
        set(key, value) {
            store.set(key, { t: Date.now(), v: value });
        },
        /**
         * Cooperate with concurrent fetchers: if a refresh is already running for `key`,
         * piggy-back on it instead of issuing a duplicate query.
         */
        async fetch(key, fetcher) {
            const existing = inflight.get(key);
            if (existing) return existing;
            const p = Promise.resolve()
                .then(() => fetcher())
                .then((v) => { store.set(key, { t: Date.now(), v }); return v; })
                .finally(() => { inflight.delete(key); });
            inflight.set(key, p);
            return p;
        },
        /** Trigger refresh in background; never throws. */
        revalidate(key, fetcher) {
            if (inflight.has(key)) return;
            this.fetch(key, fetcher).catch(() => {/* swallow; stale data already served */});
        },
        invalidate(key) { if (key == null) store.clear(); else store.delete(key); },
    };
}

// Serial sets (3 distinct queries) — small payload, refresh aggressively.
const _stockSerialSetCache = _makeSwrCache({ freshMs: 15_000, maxStaleMs: 5 * 60_000 });
// Populated purchases — heavy fetch, refresh less aggressively to avoid thrash.
const _purchasesCache = _makeSwrCache({ freshMs: 60_000, maxStaleMs: 10 * 60_000 });
// Barcode→productId map — small, derived from Product collection.
const _barcodeMapCache = _makeSwrCache({ freshMs: 60_000, maxStaleMs: 10 * 60_000 });

exports.invalidateStockSerialSetCache = function (tenantId) { _stockSerialSetCache.invalidate(tenantId); };
exports.invalidateStockPurchasesCache = function (tenantId) { _purchasesCache.invalidate(tenantId); _barcodeMapCache.invalidate(tenantId); };

/** Slugs in Edit Category display order (for stock table columns). */
function getVariantAttributeSlugOrderFromCategory(cat) {
    if (!cat || typeof cat !== 'object') return undefined;
    const attrs = cat.variantAttributes;
    if (!Array.isArray(attrs) || attrs.length === 0) return undefined;
    const slugs = [];
    for (const a of attrs) {
        if (!a) continue;
        const slug = (typeof a === 'object' && a.slug != null)
            ? String(a.slug).trim().toLowerCase()
            : '';
        if (slug) slugs.push(slug);
    }
    return slugs.length ? slugs : undefined;
}

/** Flatten purchases to stock view rows (one per IMEI or one per non-serial item). Used for paginated stock view.
 * @param {Array} purchases
 * @param {Set<string>} soldSet - set of sold IMEI strings
 * @param {{ skipSold?: boolean, productType?: string }} [opts]
 */
function flattenPurchasesToStockRows(purchases, soldSet, opts) {
    const skipSold = opts && opts.skipSold;
    const productType = (opts && opts.productType) || 'all';
    const rows = [];
    const getCategoryName = (c) => {
        if (!c) return '';
        if (typeof c === 'object' && c && c.name) return c.name || '';
        return String(c);
    };
    const getCondition = (item) => {
        if (item.grade != null && String(item.grade).trim()) return String(item.grade).trim();
        const vv = item.variantValues || [];
        const entry = vv.find((e) => ((e.slug || '').toLowerCase() === 'grade' || (e.slug || '').toLowerCase() === 'condition') && e.value);
        return entry ? String(entry.value).trim() : '';
    };
    const formatDate = (d) => {
        if (!d) return '';
        try {
            const date = new Date(d);
            return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch {
            return String(d);
        }
    };

    for (const purchase of purchases) {
        const purchaseId = purchase._id;
        const supplierName = purchasePartyLabel(purchase);
        const dateStr = formatDate(purchase.date);
        const createdAt = purchase.createdAt || purchase.date;
        const items = purchase.items || [];

        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            const item = items[itemIndex];
            const itemId = item._id || `item-${itemIndex}`;
            const imeis = Array.isArray(item.imeis) ? item.imeis : [];
            // Serial = has IMEIs and not explicitly "other". Non-serial = no IMEIs (qty-only) or isOtherItem true.
            const isSerialProduct = imeis.length > 0 && !(item.isOtherItem === true);

            // Skip items that don't match the requested product type (avoids creating row objects we'd discard)
            if (productType === 'serial' && !isSerialProduct) continue;
            if (productType === 'non-serial' && isSerialProduct) continue;

            const base = {
                purchaseNumber: purchase.purchaseNumber || '',
                parcelNumber: purchase.parcelNumber || '',
                date: dateStr,
                createdAt,
                supplier: supplierName,
                currency: purchase.currency || '',
                status: purchase.status || '',
                paymentStatus: purchase.paymentStatus || '',
                category: getCategoryName(item.category),
                grade: getCondition(item),
                brand: item.brand ?? '',
                brandModel: item.brandModel ?? '',
                capacity: item.capacity ?? '',
                colour: item.colour ?? '',
                purchasePrice: Number(item.purchasePrice) || 0,
                salePrice: Number(item.salePrice) || 0,
                name: item.name ? String(item.name).trim() : undefined,
                barcode: item.barcode ? String(item.barcode).trim() : undefined,
                variantValues: Array.isArray(item.variantValues) ? item.variantValues : undefined,
                variantAttributeSlugsOrder: getVariantAttributeSlugOrderFromCategory(item.category),
                sendTo: item.sendTo || null,
                serialItemIdNumber: item.serialItemIdNumber || '',
                note: purchase.note || ''
            };

            // Build IMEI -> per-unit SID map (new purchases). Falls back to item-level SID for legacy data.
            const imeiSidByImei = new Map();
            if (Array.isArray(item.imeiSerials)) {
                for (const entry of item.imeiSerials) {
                    if (entry && entry.imei) imeiSidByImei.set(String(entry.imei).trim(), entry.serialItemIdNumber || '');
                }
            }

            // Pre-compute searchable string once (avoids re-joining 15 fields per row on every search request).
            // variantValues carry extra dimensions like RAM / Processor that aren't on the base columns.
            const variantSearchTokens = Array.isArray(item.variantValues)
                ? item.variantValues
                    .map((v) => (v && (v.value || v.name || v.label)) || '')
                    .filter(Boolean)
                    .join(' ')
                : '';
            const baseSearchable = [
                base.purchaseNumber, base.parcelNumber, base.date, base.supplier,
                base.status, base.paymentStatus, base.category, base.grade,
                base.brand, base.brandModel, base.capacity, base.colour,
                base.name || '', base.barcode || '', variantSearchTokens
            ].join(' ').toLowerCase();

            if (imeis.length > 0) {
                for (let i = 0; i < imeis.length; i++) {
                    const imeiStr = (imeis[i] && String(imeis[i]).trim()) || '-';
                    const isSold = soldSet.has(imeiStr);
                    if (skipSold && isSold) continue;
                    const perImeiSid = imeiSidByImei.get(imeiStr);
                    rows.push({
                        ...base,
                        imei: imeiStr,
                        // Per-IMEI SID overrides the item-level legacy SID when present.
                        serialItemIdNumber: perImeiSid || base.serialItemIdNumber,
                        _searchable: baseSearchable + ' ' + imeiStr.toLowerCase(),
                        rowKey: `${purchaseId}-${itemId}-${i}-${imeiStr}`,
                        isSerialProduct,
                        _isSold: isSold,
                        purchaseId: String(purchaseId),
                        itemId: String(itemId)
                    });
                }
            } else {
                // `Number(item.quantity) || 1` would render qty=0 as 1 (0 is falsy in JS),
                // making sold-out non-serial items appear to still have one in stock.
                const rawQty = Number(item.quantity);
                const qty = Number.isFinite(rawQty) ? rawQty : 0;
                const isSold = qty <= 0;
                // Match serial behaviour: when statusFilter=available (skipSold=true),
                // hide depleted non-serial lines instead of showing them with qty=0.
                if (skipSold && isSold) continue;
                rows.push({
                    ...base,
                    imei: '-',
                    _searchable: baseSearchable + ' ' + String(qty),
                    rowKey: `${purchaseId}-${itemId}-no-imei`,
                    isSerialProduct,
                    quantity: qty,
                    purchaseId: String(purchaseId),
                    itemId: String(itemId),
                    _isSold: isSold
                });
            }
        }
    }
    return rows;
}

/** Return non-serial stock rows only (for stock transfer quantity-line options). Exported for use by stockTransferController.
 * @param {string} tenantId - Tenant scope
 * @param {string} [fromLocationId] - If provided, only return rows where item.sendTo equals this location (stock at that location).
 */
async function getNonSerialStockRowsForTransfer(tenantId, fromLocationId) {
    const tid = tenantId || 'default';
    const soldSet = new Set((await distinctSerialNumbersSoldOnActiveSales()).map((s) => String(s).trim()));
    const purchases = await Purchase.find({ tenantId: tid })
        .populate('items.category', 'name')
        .sort('-createdAt')
        .limit(5000)
        .lean();
    const rows = flattenPurchasesToStockRows(purchases, soldSet);
    let filtered = rows.filter((r) => !r.isSerialProduct && !r._isSold);
    if (fromLocationId) {
        const locId = String(fromLocationId);
        filtered = filtered.filter((r) => {
            const sendTo = r.sendTo;
            const sendToStr = sendTo && (sendTo._id ? String(sendTo._id) : String(sendTo));
            return sendToStr === locId;
        });
    }
    return filtered;
}

// @desc    Get paginated stock view rows (flattened inventory for products page)
// @route   GET /api/purchases/stock-view-rows
// @access  Private
exports.getStockViewRows = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const requestedLimit = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const limit = Math.min(10000, requestedLimit);
    const excludeSold = req.query.excludeSold === 'true';
    const statusFilter = (req.query.statusFilter || 'available').toLowerCase(); // available | sold | all
    const productType = (req.query.productType || 'all').toLowerCase(); // all | serial | non-serial
    const search = (req.query.search || '').trim().toLowerCase();
    const category = (req.query.category || '').trim();
    const brand = (req.query.brand || '').trim();
    const brandModel = (req.query.brandModel || '').trim();
    const capacity = (req.query.capacity || '').trim();
    const colour = (req.query.colour || '').trim();
    const imei = (req.query.imei || '').trim();
    const locationId = (req.query.locationId || '').trim() || null;

    const tenantId = getTenantIdFromReq(req);
    const categoryIdPushedDown = false; // category filter is by name post-flatten (kept for downstream code)

    // Non-serial items have no IMEIs, so serial-related queries (sold set, returned-to-supplier) are unnecessary.
    const needsSerialQueries = productType !== 'non-serial';

    // ── Fetcher fns: each fully refreshes one cache slice. Used for both cold fetch and SWR refresh. ──
    const fetchSerialSets = async () => {
        const [a, b, c] = await Promise.all([
            distinctSerialNumbersSoldOnActiveSales(),
            SerialHistory.distinct('serialNumber', { eventType: 'returned_to_supplier' }),
            SoldSerial.distinct('serialNumber', { status: 'returned', returnDestination: 'return_to_supplier' }),
        ]);
        return { soldSerials: a, returnedToSupplierSerials: b, soldReturnedToSupplierSerials: c };
    };

    const fetchPurchasesAndResolve = async () => {
        const docs = await Purchase.find({ tenantId })
            .select('purchaseNumber parcelNumber date createdAt currency status paymentStatus note supplier account items')
            .populate('supplier', 'name contactPerson')
            .populate('account', 'name contactPerson contactName')
            .populate('items.category', 'name variantAttributes')
            .populate('items.sendTo', 'name type')
            .sort('-createdAt')
            .limit(STOCK_VIEW_MAX_PURCHASES)
            .lean();
        // Batch-resolve variantAttributes for every unique category in one query (replaces nested populate).
        const catIds = new Set();
        for (const p of docs) {
            for (const it of (p.items || [])) {
                const c = it.category;
                if (c && typeof c === 'object' && Array.isArray(c.variantAttributes)) {
                    for (const vid of c.variantAttributes) {
                        if (vid && typeof vid !== 'object') catIds.add(String(vid));
                    }
                }
            }
        }
        if (catIds.size > 0) {
            const VariantAttribute = require('../models/VariantAttribute');
            const attrs = await VariantAttribute.find({ _id: { $in: [...catIds] } }).select('slug').lean();
            const attrMap = new Map(attrs.map((a) => [String(a._id), a]));
            for (const p of docs) {
                for (const it of (p.items || [])) {
                    const c = it.category;
                    if (c && typeof c === 'object' && Array.isArray(c.variantAttributes)) {
                        c.variantAttributes = c.variantAttributes.map((vid) => attrMap.get(String(vid)) || vid);
                    }
                }
            }
        }
        return docs;
    };

    // ── SWR resolution: serve cached data immediately when available; trigger background refresh if stale. ──
    const cachedSets = needsSerialQueries ? _stockSerialSetCache.get(tenantId) : null;
    const cachedPurchases = _purchasesCache.get(tenantId);

    let setsP, purchasesP;
    if (cachedSets) {
        setsP = Promise.resolve(cachedSets.value);
        if (cachedSets.isStale) _stockSerialSetCache.revalidate(tenantId, fetchSerialSets);
    } else if (needsSerialQueries) {
        setsP = _stockSerialSetCache.fetch(tenantId, fetchSerialSets);
    } else {
        setsP = Promise.resolve({ soldSerials: [], returnedToSupplierSerials: [], soldReturnedToSupplierSerials: [] });
    }
    if (cachedPurchases) {
        purchasesP = Promise.resolve(cachedPurchases.value);
        if (cachedPurchases.isStale) _purchasesCache.revalidate(tenantId, fetchPurchasesAndResolve);
    } else {
        purchasesP = _purchasesCache.fetch(tenantId, fetchPurchasesAndResolve);
    }

    const [setsVal, purchases] = await Promise.all([setsP, purchasesP]);
    const { soldSerials, returnedToSupplierSerials, soldReturnedToSupplierSerials } = setsVal;

    const soldSet = new Set((soldSerials || []).map((s) => String(s).trim()));
    const returnedToSupplierSet = new Set(
        [...(returnedToSupplierSerials || []), ...(soldReturnedToSupplierSerials || [])]
            .map((s) => String(s).trim())
            .filter(Boolean)
    );

    // Flatten with early skipping: skipSold avoids creating row objects for sold items when status=available,
    // productType skips non-matching items during iteration instead of filtering afterwards.
    const skipSold = statusFilter === 'available';
    const allRows = flattenPurchasesToStockRows(purchases, soldSet, { skipSold, productType });

    // Single-pass filter — replaces 7 sequential .filter() calls (each allocates a new array).
    const imeiLower = imei ? imei.toLowerCase() : '';
    const onlySold = statusFilter === 'sold';
    const checkReturned = returnedToSupplierSet.size > 0;
    const checkCategoryByName = category && !categoryIdPushedDown;

    const rows = [];
    for (let i = 0; i < allRows.length; i++) {
        const r = allRows[i];
        if (onlySold && !r._isSold) continue;
        if (checkReturned && r.isSerialProduct && r.imei && r.imei !== '-' && returnedToSupplierSet.has(String(r.imei).trim())) continue;
        if (checkCategoryByName && (r.category || '').trim() !== category) continue;
        // brand/brandModel/capacity/colour are pushed down at the doc level via $elemMatch, but we must
        // re-check per item because $elemMatch only guarantees AT LEAST ONE matching item per doc.
        if (brand && (r.brand || '').trim() !== brand) continue;
        if (brandModel && (r.brandModel || '').trim() !== brandModel) continue;
        if (capacity && (r.capacity || '').trim() !== capacity) continue;
        if (colour && (r.colour || '').trim() !== colour) continue;
        if (imeiLower && !(r.imei || '').toLowerCase().includes(imeiLower)) continue;
        if (search && !r._searchable.includes(search)) continue;
        if (locationId) {
            const sendTo = r.sendTo;
            if (sendTo) {
                const id = typeof sendTo === 'object' ? String(sendTo._id) : String(sendTo);
                if (id !== locationId) continue;
            }
        }
        rows.push(r);
    }

    // Resolve productId by barcode (cached per-tenant via SWR — barcode→productId rarely changes).
    const fetchBarcodeMap = async () => {
        const products = await Product.find({ tenantId, isActive: true })
            .select('_id barcode')
            .lean();
        const map = {};
        for (const p of products) {
            if (p.barcode) map[String(p.barcode).trim()] = String(p._id);
        }
        return map;
    };
    const cachedBarcodeMap = _barcodeMapCache.get(tenantId);
    let barcodeToProductId;
    if (cachedBarcodeMap) {
        barcodeToProductId = cachedBarcodeMap.value;
        if (cachedBarcodeMap.isStale) _barcodeMapCache.revalidate(tenantId, fetchBarcodeMap);
    } else {
        barcodeToProductId = await _barcodeMapCache.fetch(tenantId, fetchBarcodeMap);
    }
    for (const r of rows) {
        if (r.barcode) {
            const id = barcodeToProductId[String(r.barcode).trim()];
            if (id) r.productId = id;
        }
    }

    // productId is set only when row.barcode matches a Product; no arbitrary fallback (safe for pricing-group rate list).

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const pageRows = rows.slice(start, start + limit);

    // Fetch sold info only for serials on this page (avoids separate getSoldSerials call from frontend)
    const soldImeisOnPage = [...new Set(pageRows.filter((r) => r._isSold && r.imei && r.imei !== '-').map((r) => String(r.imei).trim()))];
    let soldInfoByImei = {};
    if (soldImeisOnPage.length > 0) {
        const soldDocs = await SoldSerial.find({ serialNumber: { $in: soldImeisOnPage }, status: { $ne: 'returned' } })
            .select('serialNumber saleId')
            .populate('saleId', 'customerName reference status')
            .lean();
        soldDocs.forEach((s) => {
            if (s.saleId && s.saleId.status === 'voided') return;
            const key = (s.serialNumber && String(s.serialNumber).trim()) || '';
            if (key) {
                soldInfoByImei[key] = {
                    customerName: (s.saleId && s.saleId.customerName) ? String(s.saleId.customerName) : 'Walk-in',
                    saleReference: (s.saleId && s.saleId.reference) ? String(s.saleId.reference) : '',
                    saleId: (s.saleId && s.saleId._id) ? String(s.saleId._id) : ''
                };
            }
        });
    }

    // Distinct filter options from the full filtered set (single pass instead of 5 separate iterations)
    const catSet = new Set();
    const brandSet = new Set();
    const modelSet = new Set();
    const capSet = new Set();
    const colSet = new Set();
    const locMap = {};
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const cat = (r.category || '').trim();
        if (cat) catSet.add(cat);
        const br = (r.brand || '').trim();
        if (br) brandSet.add(br);
        const md = (r.brandModel || '').trim();
        if (md) modelSet.add(md);
        const cap = (r.capacity || '').trim();
        if (cap) capSet.add(cap);
        const col = (r.colour || '').trim();
        if (col) colSet.add(col);
        const st = r.sendTo;
        if (st && typeof st === 'object' && st._id) {
            locMap[String(st._id)] = st.name || 'Unnamed';
        }
    }
    const categories = [...catSet].sort();
    const brands = [...brandSet].sort();
    const brandModels = [...modelSet].sort();
    const capacities = [...capSet].sort();
    const colours = [...colSet].sort();
    const locations = Object.entries(locMap).map(([_id, name]) => ({ _id, name })).sort((a, b) => a.name.localeCompare(b.name));

    // Remove internal fields (_isSold, _searchable, sendTo) and attach soldInfo for each row.
    const data = pageRows.map((r) => {
        const { _isSold, _searchable, sendTo, ...rest } = r;
        const soldInfo = r.imei && r.imei !== '-' ? soldInfoByImei[String(r.imei).trim()] : undefined;
        return soldInfo ? { ...rest, soldInfo } : rest;
    });

    res.status(200).json({
        success: true,
        data,
        total,
        page,
        pages,
        filterOptions: { categories, brands, brandModels, capacities, colours, locations }
    });
});

// @desc    Get single purchase
// @route   GET /api/purchases/:id
// @access  Private
exports.getPurchase = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const purchase = await Purchase.findOne({ _id: req.params.id, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    if (!purchase) {
        return res.status(404).json({
            success: false,
            message: 'Purchase not found'
        });
    }

    const data = normalizePurchasesForResponse(purchase);

    res.status(200).json({
        success: true,
        data
    });
});

/** Format: SID-000001, SID-000002, ... (6-digit sequence). Scoped by tenant.
 *  Scans both legacy item-level `serialItemIdNumber` and per-IMEI `imeiSerials[].serialItemIdNumber`. */
async function getNextSerialItemIdNumber(tenantId) {
    const tid = tenantId || 'default';
    const result = await Purchase.aggregate([
        { $match: { tenantId: tid } },
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
    let maxSeq = 0;
    if (result.length > 0 && result[0].sids) {
        const m = String(result[0].sids).match(/^SID-(\d{6})$/);
        if (m) maxSeq = parseInt(m[1], 10);
    }
    return maxSeq + 1;
}

async function getNextPurchaseNumber(tenantId) {
    const tid = tenantId || 'default';
    const last = await Purchase.findOne({ tenantId: tid, purchaseNumber: /^PUR-\d{6}$/ })
        .sort({ purchaseNumber: -1 })
        .select('purchaseNumber')
        .lean();
    let seq = 1;
    if (last && last.purchaseNumber) {
        const match = last.purchaseNumber.match(/^PUR-(\d{6})$/);
        if (match) seq = parseInt(match[1], 10) + 1;
    }
    return `PUR-${String(seq).padStart(6, '0')}`;
}

/**
 * When a new purchase is created, set salePrice on ALL existing purchase items that share the same variant
 * (category, grade, brand, brandModel, capacity — colour does not affect). Groups by unique variant so we do
 * one updateMany per variant instead of per item (much faster for bulk imports).
 * @param {import('mongoose').Document} purchase - Newly created purchase with items
 */
async function syncSalePriceToSameVariant(purchase) {
    if (!purchase || !purchase.items || purchase.items.length === 0) return;
    const newPurchaseId = purchase._id;
    const items = Array.isArray(purchase.items) ? purchase.items : [];
    const regexOpt = 'i';
    // One update per unique variant (category, grade, brand, brandModel, capacity) to avoid 400 updates for 400 items
    const variantToSalePrice = new Map();
    for (const newItem of items) {
        const salePrice = Number(newItem.salePrice);
        if (salePrice < 0 || Number.isNaN(salePrice)) continue;
        const categoryId = (newItem.category && (newItem.category._id || newItem.category))?.toString?.() ?? '';
        const grade = (newItem.grade != null && String(newItem.grade).trim()) ? String(newItem.grade).trim() : '';
        const brand = (newItem.brand != null && String(newItem.brand).trim()) ? String(newItem.brand).trim() : '';
        const brandModel = (newItem.brandModel != null && String(newItem.brandModel).trim()) ? String(newItem.brandModel).trim() : '';
        const capacity = (newItem.capacity != null && String(newItem.capacity).trim()) ? String(newItem.capacity).trim() : '';
        const key = `${categoryId}|${grade}|${brand}|${brandModel}|${capacity}`;
        if (!variantToSalePrice.has(key)) variantToSalePrice.set(key, { salePrice, grade, brand, brandModel, capacity, categoryId });
    }
    for (const { salePrice, grade, brand, brandModel, capacity, categoryId } of variantToSalePrice.values()) {
        const arrayFilter = {};
        if (categoryId) arrayFilter['elem.category'] = categoryId;
        if (grade !== undefined && grade !== '') arrayFilter['elem.grade'] = { $regex: new RegExp('^\\s*' + escapeRegex(grade) + '\\s*$', regexOpt) };
        if (brand !== undefined && brand !== '') arrayFilter['elem.brand'] = { $regex: new RegExp('^\\s*' + escapeRegex(brand) + '\\s*$', regexOpt) };
        if (brandModel !== undefined && brandModel !== '') arrayFilter['elem.brandModel'] = { $regex: new RegExp('^\\s*' + escapeRegex(brandModel) + '\\s*$', regexOpt) };
        if (capacity !== undefined && capacity !== '') arrayFilter['elem.capacity'] = { $regex: new RegExp('^\\s*' + escapeRegex(capacity) + '\\s*$', regexOpt) };
        // Require full variant: category + brand + brandModel + grade + capacity all set.
        // Any blank field would broaden the updateMany to unrelated items.
        const hasFullVariant = arrayFilter['elem.category']
            && arrayFilter['elem.brand']
            && arrayFilter['elem.brandModel']
            && arrayFilter['elem.grade']
            && arrayFilter['elem.capacity'];
        if (!hasFullVariant) continue;
        const purchaseTenantId = purchase.tenantId || 'default';
        await Purchase.updateMany(
            { tenantId: purchaseTenantId, _id: { $ne: newPurchaseId } },
            { $set: { 'items.$[elem].salePrice': salePrice } },
            { arrayFilters: [arrayFilter] }
        );
    }
}

// @desc    Create purchase
// @route   POST /api/purchases
// @access  Private (admin, manager)
exports.createPurchase = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    if (req.body.tenantId !== undefined) delete req.body.tenantId;
    req.body.tenantId = tenantId;
    req.body.createdBy = req.user.id;

    if (req.body.supplier && !req.body.account) {
        req.body.account = req.body.supplier;
        req.body.accountModel = 'Supplier';
    }
    if (req.body.account && !req.body.accountModel) {
        req.body.accountModel = 'Supplier';
    }

    // Require either account or supplier
    if (!req.body.account && !req.body.supplier) {
        return res.status(400).json({
            success: false,
            message: 'Kindly add a supplier first'
        });
    }

    // Require purchase price and sale price on every item
    if (req.body.items && req.body.items.length > 0) {
        for (let i = 0; i < req.body.items.length; i++) {
            const it = req.body.items[i];
            const pp = Number(it.purchasePrice);
            const sp = Number(it.salePrice);
            if (pp == null || pp <= 0 || Number.isNaN(pp)) {
                return res.status(400).json({
                    success: false,
                    message: `Item ${i + 1}: Purchase price is required and must be greater than 0.`
                });
            }
            if (sp == null || sp <= 0 || Number.isNaN(sp)) {
                return res.status(400).json({
                    success: false,
                    message: `Item ${i + 1}: Sale price is required and must be greater than 0.`
                });
            }
        }
    }

    if (req.body.items && req.body.items.length > 0) {
        req.body.items = normalizePurchaseItems(req.body.items);
        req.body.items = dedupeOtherItemsByBarcodeKeepingFirst(req.body.items);
        recomputePurchaseAggregatesFromItems(req.body);
    }

    const uniqueness = await validateUniqueBarcodeAndImei(req.body.items, undefined, tenantId);
    if (!uniqueness.valid) {
        return res.status(400).json({
            success: false,
            message: uniqueness.message
        });
    }

    // Auto-generate a unique SID per individual IMEI (one SID per unit), stored in item.imeiSerials.
    if (req.body.items && req.body.items.length > 0) {
        let nextSeq = await getNextSerialItemIdNumber(tenantId);
        for (const item of req.body.items) {
            if (!item.isOtherItem && Array.isArray(item.imeis) && item.imeis.length > 0) {
                item.imeiSerials = item.imeis.map((imei) => ({
                    imei: String(imei),
                    serialItemIdNumber: `SID-${String(nextSeq++).padStart(6, '0')}`
                }));
                // Leave legacy item-level serialItemIdNumber unset for new purchases.
                delete item.serialItemIdNumber;
            }
        }
    }

    let purchase;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        req.body.purchaseNumber = await getNextPurchaseNumber(tenantId);
        try {
            purchase = await Purchase.create(req.body);
            break;
        } catch (err) {
            if (attempt < maxRetries - 1 && err.code === 11000 && err.keyValue && err.keyValue.purchaseNumber) {
                continue;
            }
            throw err;
        }
    }

    // SerialIndex: upsert in_stock for each IMEI (fast lookup for find-in-stock-serials)
    if (purchase.items && purchase.items.length > 0) {
        for (let i = 0; i < purchase.items.length; i++) {
            const it = purchase.items[i];
            const imeis = Array.isArray(it.imeis) ? it.imeis : [];
            for (const imei of imeis) {
                const serial = serialIndexService.normalizeSerial(imei);
                if (!serial) continue;
                const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
                const name = formatProductName(parts.length > 0 ? parts.join(' ') : (it.name && it.name.trim() ? it.name.trim() : 'Product'));
                const skuSnapshot = `${purchase._id}-${it._id}`;
                serialIndexService.upsertSerialIndex(tenantId, {
                    serial,
                    status: 'in_stock',
                    productNameSnapshot: name,
                    skuSnapshot,
                    purchaseId: purchase._id,
                    purchaseItemId: it._id,
                    unitCost: Number(it.purchasePrice) || null,
                    salePrice: Number(it.salePrice) || null,
                    locationId: it.sendTo || null,
                    purchaseDate: purchase.createdAt || purchase.date,
                }).catch(() => {});
            }
        }
    }

    // Accounts: ledger entry for supplier (we owe grandTotal; payments reduce via payment_out)
    const supplierId = purchase.supplier || purchase.account;
    const grandTotal = Number(purchase.grandTotal) || 0;
    const initialPaid = Number(purchase.paid) || 0;
    if (supplierId && grandTotal > 0) {
        await LedgerEntry.create({
            accountType: 'supplier',
            accountId: supplierId,
            accountModel: purchase.accountModel || 'Supplier',
            type: 'purchase',
            amount: grandTotal,
            referenceId: purchase._id,
            referenceLabel: purchase.purchaseNumber || `PUR-${purchase._id}`,
            date: purchase.date || new Date(),
            createdBy: req.user?.id
        });
        if (initialPaid > 0) {
            await LedgerEntry.create({
                accountType: 'supplier',
                accountId: supplierId,
                accountModel: purchase.accountModel || 'Supplier',
                type: 'payment_out',
                amount: -initialPaid,
                referenceId: purchase._id,
                referenceLabel: purchase.purchaseNumber || `PUR-${purchase._id}`,
                date: new Date(),
                paymentMethod: 'bank',
                note: 'Initial payment',
                createdBy: req.user?.id
            });
        }
    }

    // When adding a new product with same SKU (variant), optionally sync its sale price to all existing items (see Settings > General).
    // Skip for large batches (bulk import) to keep import fast.
    const isBulkImport = (req.body.items && req.body.items.length > 150);
    try {
        const invSettings = await InventorySettings.getSettings().catch(() => null);
        if (!isBulkImport && (!invSettings || invSettings.syncSalePriceToSameVariant !== false)) {
            await syncSalePriceToSameVariant(purchase);
        }
    } catch (syncErr) {
        console.warn('syncSalePriceToSameVariant after create:', syncErr?.message || syncErr);
    }

    const populated = await Purchase.findOne({ _id: purchase._id, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    const data = normalizePurchasesForResponse(populated);

    await auditService.logFromReq(req, 'Purchase', purchase._id, 'CREATE', { after: purchase.toObject() });
    await activityLogService.logParcelEvent(req, 'PARCEL_CREATED', populated);

    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    exports.invalidateStockPurchasesCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);
    // Populate the StockItem index for the new purchase (denormalized read model).
    stockItemService.rebuildForPurchase(populated).catch(() => {});

    res.status(201).json({
        success: true,
        data
    });
});

// @desc    Update purchase
// @route   PUT /api/purchases/:id
// @access  Private (admin, manager)
exports.updatePurchase = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    if (req.body.tenantId !== undefined) delete req.body.tenantId;
    let purchase = await Purchase.findOne({ _id: req.params.id, tenantId });

    if (!purchase) {
        return res.status(404).json({
            success: false,
            message: 'Purchase not found'
        });
    }
    const beforeSnapshot = purchase.toObject();

    if (req.body.items && req.body.items.length > 0) {
        for (let i = 0; i < req.body.items.length; i++) {
            const it = req.body.items[i];
            const pp = Number(it.purchasePrice);
            const sp = Number(it.salePrice);
            if (pp == null || pp <= 0 || Number.isNaN(pp)) {
                return res.status(400).json({
                    success: false,
                    message: `Item ${i + 1}: Purchase price is required and must be greater than 0.`
                });
            }
            if (sp == null || sp <= 0 || Number.isNaN(sp)) {
                return res.status(400).json({
                    success: false,
                    message: `Item ${i + 1}: Sale price is required and must be greater than 0.`
                });
            }
        }
        req.body.items = normalizePurchaseItems(req.body.items);
        req.body.items = dedupeOtherItemsByBarcodeKeepingFirst(req.body.items);
        recomputePurchaseAggregatesFromItems(req.body);
        const uniqueness = await validateUniqueBarcodeAndImei(req.body.items, req.params.id, tenantId);
        if (!uniqueness.valid) {
            return res.status(400).json({
                success: false,
                message: uniqueness.message
            });
        }
    }

    purchase = await Purchase.findOneAndUpdate({ _id: req.params.id, tenantId }, req.body, {
        new: true,
        runValidators: true
    })
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    if (purchase.items && purchase.items.length > 0) {
        for (let i = 0; i < purchase.items.length; i++) {
            const it = purchase.items[i];
            const imeis = Array.isArray(it.imeis) ? it.imeis : [];
            for (const imei of imeis) {
                const serial = serialIndexService.normalizeSerial(imei);
                if (!serial) continue;
                const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
                const name = formatProductName(parts.length > 0 ? parts.join(' ') : (it.name && it.name.trim() ? it.name.trim() : 'Product'));
                const skuSnapshot = `${purchase._id}-${it._id}`;
                serialIndexService.upsertSerialIndex(tenantId, {
                    serial,
                    status: 'in_stock',
                    productNameSnapshot: name,
                    skuSnapshot,
                    purchaseId: purchase._id,
                    purchaseItemId: it._id,
                    unitCost: Number(it.purchasePrice) || null,
                    salePrice: Number(it.salePrice) || null,
                    locationId: it.sendTo || null,
                    purchaseDate: purchase.createdAt || purchase.date,
                }).catch(() => {});
            }
        }
    }

    await auditService.logFromReq(req, 'Purchase', purchase._id, 'UPDATE', {
        before: beforeSnapshot,
        after: purchase.toObject()
    });
    await activityLogService.logParcelEvent(req, 'PARCEL_UPDATED', purchase, { before: beforeSnapshot });

    invalidateForSalesCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);

    const data = normalizePurchasesForResponse(purchase);

    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Update only parcel/quantity details (no items)
// @route   PATCH /api/purchases/:id/details
// @access  Private (admin, manager)
exports.updatePurchaseDetails = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const purchase = await Purchase.findOne({ _id: req.params.id, tenantId });
    if (!purchase) {
        return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    const beforeSnapshot = purchase.toObject();

    const body = req.body || {};

    if (body.supplier && !body.account) {
        body.account = body.supplier;
        body.accountModel = body.accountModel || 'Supplier';
    }
    if (body.account && !body.accountModel) {
        body.accountModel = 'Supplier';
    }

    const hasSupplier = body.supplier || body.account || purchase.supplier || purchase.account;
    if (!hasSupplier) {
        return res.status(400).json({ success: false, message: 'Kindly add a supplier first' });
    }

    const allowed = ['parcelNumber', 'date', 'currency', 'note', 'imeiQuantity', 'otherQuantity', 'supplier', 'account', 'accountModel'];
    const update = {};
    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
    }

    const updated = await Purchase.findOneAndUpdate(
        { _id: req.params.id, tenantId },
        { $set: update },
        { new: true, runValidators: true }
    )
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    await auditService.logFromReq(req, 'Purchase', updated._id, 'UPDATE', {
        before: beforeSnapshot,
        after: updated.toObject()
    });
    await activityLogService.logParcelEvent(req, 'PARCEL_UPDATED', updated, { before: beforeSnapshot });

    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);
    stockItemService.rebuildForPurchase(updated).catch(() => {});

    res.status(200).json({ success: true, data: normalizePurchasesForResponse(updated) });
});

// @desc    Update a single purchase item (quantity for non-serial; salePrice for any item)
// @route   PATCH /api/purchases/:purchaseId/items/:itemId
// @access  Private (admin, manager)
// Retries on VersionError when multiple PATCHes hit the same purchase (e.g. rate list bulk price update).
const MAX_PURCHASE_UPDATE_RETRIES = 5;
exports.updatePurchaseItemQuantity = asyncHandler(async (req, res) => {
    const { purchaseId, itemId } = req.params;
    const quantity = req.body.quantity != null ? Number(req.body.quantity) : null;
    const salePrice = req.body.salePrice != null ? Number(req.body.salePrice) : null;
    const purchasePrice = req.body.purchasePrice != null ? Number(req.body.purchasePrice) : null;

    if (quantity === null && salePrice === null && purchasePrice === null) {
        return res.status(400).json({
            success: false,
            message: 'At least one of quantity, salePrice or purchasePrice is required'
        });
    }
    if (quantity !== null && !Number.isInteger(quantity)) {
        return res.status(400).json({
            success: false,
            message: 'Quantity must be an integer'
        });
    }
    if (salePrice !== null && (typeof salePrice !== 'number' || isNaN(salePrice) || salePrice < 0)) {
        return res.status(400).json({
            success: false,
            message: 'Sale price must be a non-negative number'
        });
    }
    if (purchasePrice !== null && (typeof purchasePrice !== 'number' || isNaN(purchasePrice) || purchasePrice < 0)) {
        return res.status(400).json({
            success: false,
            message: 'Cost price must be a non-negative number'
        });
    }

    const tenantId = getTenantIdFromReq(req);
    let lastError;
    for (let attempt = 0; attempt < MAX_PURCHASE_UPDATE_RETRIES; attempt++) {
        const purchase = await Purchase.findOne({ _id: purchaseId, tenantId });
        if (!purchase) {
            return res.status(404).json({
                success: false,
                message: 'Purchase not found'
            });
        }

        const item = (purchase.items || []).find(
            (i) => String(i._id) === String(itemId)
        );
        if (!item) {
            return res.status(404).json({
                success: false,
                message: 'Item not found in this purchase'
            });
        }

        if (quantity !== null) {
            if (!item.isOtherItem) {
                return res.status(400).json({
                    success: false,
                    message: 'Only non-serial (other) items can have their quantity updated'
                });
            }
            item.quantity = quantity;
        }
        if (salePrice !== null) {
            item.salePrice = salePrice;
            purchase.markModified('items');
        }
        if (purchasePrice !== null) {
            item.purchasePrice = purchasePrice;
            purchase.markModified('items');
        }
        try {
            await purchase.save();
            lastError = null;
            break;
        } catch (err) {
            lastError = err;
            if (err.name === 'VersionError' && attempt < MAX_PURCHASE_UPDATE_RETRIES - 1) {
                continue;
            }
            throw err;
        }
    }
    if (lastError) throw lastError;

    const purchase = await Purchase.findOne({ _id: purchaseId, tenantId });
    const item = (purchase?.items || []).find((i) => String(i._id) === String(itemId));

    // When salePrice or purchasePrice was updated on a serial item, update SerialIndex (and Redis) in the background so the response returns fast.
    // Serial lookup with no pricing group uses legacy (DB) for price, so the correct price is always from the purchase document.
    if ((salePrice !== null || purchasePrice !== null) && Array.isArray(item.imeis) && item.imeis.length > 0) {
        const parts = [item.brand, item.brandModel, item.capacity, item.colour].filter(Boolean);
        const productNameSnapshot = formatProductName(parts.length > 0 ? parts.join(' ') : (item.name && String(item.name).trim() ? String(item.name).trim() : 'Product'));
        const skuSnapshot = `${purchase._id}-${item._id}`;
        const payload = {
            status: 'in_stock',
            productNameSnapshot,
            skuSnapshot,
            purchaseId: purchase._id,
            purchaseItemId: item._id,
            unitCost: item.purchasePrice != null ? Number(item.purchasePrice) : null,
            salePrice: Number(item.salePrice) || null,
            locationId: item.sendTo || null,
            purchaseDate: purchase.createdAt || purchase.date,
        };
        const tenant = tenantId;
        const imeisList = item.imeis;
        setImmediate(() => {
            imeisList.forEach((imei) => {
                const serial = serialIndexService.normalizeSerial(imei);
                if (!serial) return;
                serialIndexService.upsertSerialIndex(tenant, { serial, ...payload }).catch(() => {});
            });
        });
    }

    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    exports.invalidateStockPurchasesCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);

    const updated = await Purchase.findOne({ _id: purchaseId, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    const data = normalizePurchasesForResponse(updated);

    // Keep StockItem in sync (price/qty changed)
    stockItemService.rebuildForPurchase(updated).catch(() => {});

    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Delete a non-serial (other) item from a purchase
// @route   DELETE /api/purchases/:purchaseId/items/:itemId
// @access  Private (admin, manager)
exports.deletePurchaseItem = asyncHandler(async (req, res) => {
    const { purchaseId, itemId } = req.params;
    const tenantId = getTenantIdFromReq(req);
    const purchase = await Purchase.findOne({ _id: purchaseId, tenantId });
    if (!purchase) {
        return res.status(404).json({
            success: false,
            message: 'Purchase not found'
        });
    }

    const itemIndex = (purchase.items || []).findIndex(
        (i) => String(i._id) === String(itemId)
    );
    if (itemIndex === -1) {
        return res.status(404).json({
            success: false,
            message: 'Item not found in this purchase'
        });
    }

    const item = purchase.items[itemIndex];
    if (!item.isOtherItem) {
        return res.status(400).json({
            success: false,
            message: 'Only non-serial (other) items can be deleted. Serial/IMEI items cannot be removed this way.'
        });
    }

    purchase.items.splice(itemIndex, 1);

    // Recalculate totals
    let totalIMEIs = 0;
    let totalOtherQuantity = 0;
    let grandTotal = 0;
    for (const it of purchase.items) {
        if (it.isOtherItem) {
            const qty = Number(it.quantity) || 0;
            totalOtherQuantity += qty;
            grandTotal += (Number(it.purchasePrice) || 0) * qty;
        } else {
            const imeiCount = (it.imeis && it.imeis.length) || 1;
            totalIMEIs += imeiCount;
            grandTotal += (Number(it.purchasePrice) || 0) * imeiCount;
        }
    }
    purchase.totalIMEIs = totalIMEIs;
    purchase.totalOtherQuantity = totalOtherQuantity;
    purchase.grandTotal = grandTotal;

    await purchase.save();

    await auditService.logFromReq(req, 'Purchase', purchaseId, 'UPDATE', {
        action: 'delete_item',
        itemId,
        itemName: item.name || item.brand || 'Non-serial item'
    });
    await activityLogService.logFromReq(req, {
        action: 'PARCEL_ITEM_DELETED',
        entityType: 'Purchase',
        entityId: purchaseId,
        invoiceNo: (purchase.purchaseNumber || '').trim(),
        success: true,
        message: `Non-serial item removed from parcel ${purchase.purchaseNumber || purchaseId}`,
        metaJson: { itemId, itemName: item.name || item.brand || 'Non-serial item' }
    });

    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    exports.invalidateStockPurchasesCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);

    const updated = await Purchase.findOne({ _id: purchaseId, tenantId })
        .populate('supplier', 'name contactPerson')
        .populate('account')
        .populate('createdBy', 'name')
        .populate('items.sendTo', 'name')
        .populate('items.tax', 'name rate type')
        .populate('items.category', 'name')
        .populate('items.subCategory', 'name');

    const data = normalizePurchasesForResponse(updated);
    stockItemService.rebuildForPurchase(updated).catch(() => {});

    res.status(200).json({
        success: true,
        message: 'Item removed from purchase',
        data
    });
});

// @desc    Get hierarchical stock list (serial items only: category → brand → model → grade → capacity → colour)
// @route   GET /api/purchases/stock-list
// @access  Private
exports.getStockList = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const query = { tenantId, status: 'Received' };
    if (req.query.status) query.status = req.query.status;

    const pipeline = [
        { $match: query },
        { $unwind: '$items' },
        // Stock list is for serial (IMEI) items only; exclude non-serial (other) items
        {
            $match: {
                'items.isOtherItem': { $ne: true },
                $expr: { $gt: [{ $size: { $ifNull: ['$items.imeis', []] } }, 0] }
            }
        },
        // Exclude sold IMEIs — only count available (unsold) serials
        {
            $lookup: {
                from: 'soldserials',
                let: { imeis: '$items.imeis' },
                pipeline: [
                    { $match: { $expr: { $in: ['$serialNumber', '$$imeis'] } } }
                ],
                as: 'soldForThisItem'
            }
        },
        {
            $addFields: {
                totalImeis: { $size: { $ifNull: ['$items.imeis', []] } },
                soldCount: { $size: '$soldForThisItem' }
            }
        },
        {
            $addFields: {
                itemCount: { $max: [0, { $subtract: ['$totalImeis', '$soldCount'] }] }
            }
        },
        { $match: { itemCount: { $gt: 0 } } },
        {
            $lookup: {
                from: 'categories',
                localField: 'items.category',
                foreignField: '_id',
                as: 'cat'
            }
        },
        {
            $addFields: {
                categoryName: { $ifNull: [{ $arrayElemAt: ['$cat.name', 0] }, ''] }
            }
        },
        // Source of truth for variant slots is items.variantValues (slug + value, written by every
        // writer regardless of slug spelling). Resolve each canonical slot via slug synonym list,
        // and fall back to the legacy field for old purchases that pre-date variantValues.
        {
            $addFields: {
                _vvBrand: { $arrayElemAt: [{ $filter: {
                    input: { $ifNull: ['$items.variantValues', []] },
                    cond: { $in: [{ $toLower: { $ifNull: ['$$this.slug', ''] } }, ['brand', 'brands', 'manufacturer']] }
                } }, 0] },
                _vvModel: { $arrayElemAt: [{ $filter: {
                    input: { $ifNull: ['$items.variantValues', []] },
                    cond: { $in: [{ $toLower: { $ifNull: ['$$this.slug', ''] } }, ['model', 'brand_model', 'brands_model', 'make']] }
                } }, 0] },
                _vvGrade: { $arrayElemAt: [{ $filter: {
                    input: { $ifNull: ['$items.variantValues', []] },
                    cond: { $in: [{ $toLower: { $ifNull: ['$$this.slug', ''] } }, ['grade', 'condition']] }
                } }, 0] },
                _vvCapacity: { $arrayElemAt: [{ $filter: {
                    input: { $ifNull: ['$items.variantValues', []] },
                    cond: { $in: [{ $toLower: { $ifNull: ['$$this.slug', ''] } }, ['capacity', 'storage']] }
                } }, 0] },
                _vvColour: { $arrayElemAt: [{ $filter: {
                    input: { $ifNull: ['$items.variantValues', []] },
                    cond: { $in: [{ $toLower: { $ifNull: ['$$this.slug', ''] } }, ['colour', 'color']] }
                } }, 0] }
            }
        },
        {
            $addFields: {
                resolvedBrand: { $let: {
                    vars: {
                        vv: { $trim: { input: { $ifNull: ['$_vvBrand.value', ''] } } },
                        lg: { $trim: { input: { $ifNull: ['$items.brand', ''] } } }
                    },
                    in: { $cond: [{ $gt: [{ $strLenCP: '$$vv' }, 0] }, '$$vv', '$$lg'] }
                } },
                resolvedModel: { $let: {
                    vars: {
                        vv: { $trim: { input: { $ifNull: ['$_vvModel.value', ''] } } },
                        lg: { $trim: { input: { $ifNull: ['$items.brandModel', ''] } } }
                    },
                    in: { $cond: [{ $gt: [{ $strLenCP: '$$vv' }, 0] }, '$$vv', '$$lg'] }
                } },
                resolvedGrade: { $let: {
                    vars: {
                        vv: { $trim: { input: { $ifNull: ['$_vvGrade.value', ''] } } },
                        lg: { $trim: { input: { $ifNull: ['$items.grade', ''] } } }
                    },
                    in: { $cond: [{ $gt: [{ $strLenCP: '$$vv' }, 0] }, '$$vv', '$$lg'] }
                } },
                resolvedCapacity: { $let: {
                    vars: {
                        vv: { $trim: { input: { $ifNull: ['$_vvCapacity.value', ''] } } },
                        lg: { $trim: { input: { $ifNull: ['$items.capacity', ''] } } }
                    },
                    in: { $cond: [{ $gt: [{ $strLenCP: '$$vv' }, 0] }, '$$vv', '$$lg'] }
                } },
                resolvedColour: { $let: {
                    vars: {
                        vv: { $trim: { input: { $ifNull: ['$_vvColour.value', ''] } } },
                        lg: { $trim: { input: { $ifNull: ['$items.colour', ''] } } }
                    },
                    in: { $cond: [{ $gt: [{ $strLenCP: '$$vv' }, 0] }, '$$vv', '$$lg'] }
                } }
            }
        },
        // Group by resolved canonical values so identical variants merge into one row regardless
        // of which writer (Add/Edit/Import) created the purchase or which slug spelling was used.
        {
            $group: {
                _id: {
                    category: { $trim: { input: { $ifNull: ['$categoryName', ''] } } },
                    brand: '$resolvedBrand',
                    model: '$resolvedModel',
                    grade: '$resolvedGrade',
                    capacity: '$resolvedCapacity',
                    colour: '$resolvedColour'
                },
                availableCount: { $sum: '$itemCount' }
            }
        },
        // Path in fixed order: category, brands, brands_model, condition, capacity, color so filters and tree show Brand and Model.
        // Send all segments (empty value kept) so tree always has the same levels; frontend shows (Unspecified) for empty.
        {
            $project: {
                _id: 0,
                path: [
                    { $concat: ['category:', { $trim: { input: { $ifNull: ['$_id.category', ''] } } }] },
                    { $concat: ['brands:', { $trim: { input: { $ifNull: ['$_id.brand', ''] } } }] },
                    { $concat: ['brands_model:', { $trim: { input: { $ifNull: ['$_id.model', ''] } } }] },
                    { $concat: ['condition:', { $trim: { input: { $ifNull: ['$_id.grade', ''] } } }] },
                    { $concat: ['capacity:', { $trim: { input: { $ifNull: ['$_id.capacity', ''] } } }] },
                    { $concat: ['color:', { $trim: { input: { $ifNull: ['$_id.colour', ''] } } }] }
                ],
                availableCount: 1
            }
        },
        { $project: { path: 1, availableCount: 1 } },
        { $sort: { path: 1 } }
    ];

    const rows = await Purchase.aggregate(pipeline);

    const items = rows.map((r) => ({
        path: r.path || [],
        availableCount: r.availableCount || 0
    }));

    res.status(200).json({
        success: true,
        data: items
    });
});

// @desc    Delete purchase
// @route   DELETE /api/purchases/:id
// @access  Private (admin)
exports.deletePurchase = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const purchase = await Purchase.findOne({ _id: req.params.id, tenantId });

    if (!purchase) {
        return res.status(404).json({
            success: false,
            message: 'Purchase not found'
        });
    }

    await purchase.deleteOne();

    invalidateForSalesCache(tenantId);
    invalidateTypeaheadCache(tenantId);
    await cache.bumpMany(['purchases:list', 'paymentAccounts:list'], tenantId);
    stockItemService.removeForPurchase(tenantId, purchase._id).catch(() => {});

    res.status(200).json({
        success: true,
        data: {}
    });
});

// @desc    Typeahead search for existing non-serial items across purchases.
//          Returns deduped matches (by barcode, or by name+category when barcode is absent)
//          using the most recent purchase line as the canonical config to populate the form.
// @route   GET /api/purchases/non-serial/search?q=<text>&limit=10
// @access  Private (purchase.view or parcel.create)
exports.searchNonSerialProducts = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const q = (req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));

    if (!q) {
        return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const pipeline = [
        { $match: { tenantId } },
        { $unwind: '$items' },
        {
            // Narrow to non-serial items first (cheap), then resolve category name, then run the search.
            $match: {
                $or: [
                    { 'items.isOtherItem': true },
                    { 'items.imeis': { $exists: false } },
                    { 'items.imeis': null },
                    { 'items.imeis': { $size: 0 } }
                ]
            }
        },
        {
            $lookup: {
                from: 'categories',
                localField: 'items.category',
                foreignField: '_id',
                as: '_categoryDoc'
            }
        },
        {
            $addFields: {
                '_categoryName': { $ifNull: [{ $arrayElemAt: ['$_categoryDoc.name', 0] }, ''] }
            }
        },
        {
            // Match across every column shown on /inventory/products?type=non-serial
            // (category, name, barcode, brand, model, capacity/storage, colour, grade/condition, plus variant values like RAM/Processor/Pack/Fragrance).
            $match: {
                $or: [
                    { '_categoryName': { $regex: regex } },
                    { 'items.name': { $regex: regex } },
                    { 'items.barcode': { $regex: regex } },
                    { 'items.brand': { $regex: regex } },
                    { 'items.brandModel': { $regex: regex } },
                    { 'items.capacity': { $regex: regex } },
                    { 'items.colour': { $regex: regex } },
                    { 'items.grade': { $regex: regex } },
                    { 'items.variantValues.value': { $regex: regex } },
                    { 'items.variantValues.name': { $regex: regex } }
                ]
            }
        },
        { $sort: { createdAt: -1 } },
        {
            $group: {
                _id: {
                    $cond: [
                        { $gt: [{ $strLenCP: { $ifNull: ['$items.barcode', ''] } }, 0] },
                        { $toUpper: { $trim: { input: '$items.barcode' } } },
                        {
                            $concat: [
                                'N:',
                                { $toUpper: { $trim: { input: { $ifNull: ['$items.name', ''] } } } },
                                '|',
                                { $toString: { $ifNull: ['$items.category', ''] } }
                            ]
                        }
                    ]
                },
                name: { $first: '$items.name' },
                barcode: { $first: '$items.barcode' },
                sendTo: { $first: '$items.sendTo' },
                tax: { $first: '$items.tax' },
                category: { $first: '$items.category' },
                subCategory: { $first: '$items.subCategory' },
                grade: { $first: '$items.grade' },
                brand: { $first: '$items.brand' },
                brandModel: { $first: '$items.brandModel' },
                capacity: { $first: '$items.capacity' },
                colour: { $first: '$items.colour' },
                variantValues: { $first: '$items.variantValues' },
                purchasePrice: { $first: '$items.purchasePrice' },
                salePrice: { $first: '$items.salePrice' },
                lastPurchaseId: { $first: '$_id' },
                lastPurchasedAt: { $first: '$createdAt' }
            }
        },
        { $sort: { lastPurchasedAt: -1 } },
        { $limit: limit },
        {
            $lookup: {
                from: 'categories',
                localField: 'category',
                foreignField: '_id',
                as: 'categoryDoc'
            }
        },
        {
            $addFields: {
                categoryName: { $arrayElemAt: ['$categoryDoc.name', 0] }
            }
        },
        { $project: { categoryDoc: 0 } }
    ];

    const results = await Purchase.aggregate(pipeline);

    res.status(200).json({
        success: true,
        count: results.length,
        data: results
    });
});

// @desc    Typeahead search for existing serial/IMEI items across purchases.
//          Returns deduped matches (category + brand + model + storage + colour + grade)
//          using the most recent purchase line as the canonical config to populate the form.
// @route   GET /api/purchases/serial/search?q=<text>&limit=10
// @access  Private (purchase.view or parcel.create)
exports.searchSerialProducts = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const q = (req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));

    if (!q) {
        return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const pipeline = [
        { $match: { tenantId } },
        { $unwind: '$items' },
        {
            // Narrow to serial items only (have a non-empty imeis array), and exclude explicit non-serial flag.
            $match: {
                'items.isOtherItem': { $ne: true },
                'items.imeis.0': { $exists: true }
            }
        },
        {
            $lookup: {
                from: 'categories',
                localField: 'items.category',
                foreignField: '_id',
                as: '_categoryDoc'
            }
        },
        {
            $addFields: {
                '_categoryName': { $ifNull: [{ $arrayElemAt: ['$_categoryDoc.name', 0] }, ''] }
            }
        },
        {
            // Match across every column used for serial items (category, brand, model, storage, colour, grade, variant values).
            $match: {
                $or: [
                    { '_categoryName': { $regex: regex } },
                    { 'items.brand': { $regex: regex } },
                    { 'items.brandModel': { $regex: regex } },
                    { 'items.capacity': { $regex: regex } },
                    { 'items.colour': { $regex: regex } },
                    { 'items.grade': { $regex: regex } },
                    { 'items.variantValues.value': { $regex: regex } },
                    { 'items.variantValues.name': { $regex: regex } }
                ]
            }
        },
        { $sort: { createdAt: -1 } },
        {
            // Dedupe key: category + brand + model + storage + colour + grade (uppercased + trimmed).
            // Two purchase lines with the same configuration collapse to one suggestion.
            $group: {
                _id: {
                    cat: { $toString: { $ifNull: ['$items.category', ''] } },
                    brand: { $toUpper: { $trim: { input: { $ifNull: ['$items.brand', ''] } } } },
                    model: { $toUpper: { $trim: { input: { $ifNull: ['$items.brandModel', ''] } } } },
                    cap: { $toUpper: { $trim: { input: { $ifNull: ['$items.capacity', ''] } } } },
                    col: { $toUpper: { $trim: { input: { $ifNull: ['$items.colour', ''] } } } },
                    grd: { $toUpper: { $trim: { input: { $ifNull: ['$items.grade', ''] } } } }
                },
                sendTo: { $first: '$items.sendTo' },
                tax: { $first: '$items.tax' },
                category: { $first: '$items.category' },
                subCategory: { $first: '$items.subCategory' },
                grade: { $first: '$items.grade' },
                brand: { $first: '$items.brand' },
                brandModel: { $first: '$items.brandModel' },
                capacity: { $first: '$items.capacity' },
                colour: { $first: '$items.colour' },
                variantValues: { $first: '$items.variantValues' },
                purchasePrice: { $first: '$items.purchasePrice' },
                salePrice: { $first: '$items.salePrice' },
                lastPurchaseId: { $first: '$_id' },
                lastPurchasedAt: { $first: '$createdAt' }
            }
        },
        { $sort: { lastPurchasedAt: -1 } },
        { $limit: limit },
        {
            $lookup: {
                from: 'categories',
                localField: 'category',
                foreignField: '_id',
                as: 'categoryDoc'
            }
        },
        {
            $addFields: {
                categoryName: { $arrayElemAt: ['$categoryDoc.name', 0] }
            }
        },
        { $project: { categoryDoc: 0 } }
    ];

    const results = await Purchase.aggregate(pipeline);

    res.status(200).json({
        success: true,
        count: results.length,
        data: results
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Dedicated POS / create-sales item typeahead.
//
// Why: legacy /api/purchases?forSales=1 returns *every* in-stock row (limit 2000)
// then the client filters in memory — a 1–2 second wait on every keystroke flow.
// This endpoint moves filtering to MongoDB with field-level indexes + a wildcard
// text index, returns only the top N matching rows (one per IMEI / one per
// non-serial item), and pre-resolves customer-group pricing for those rows only.
//
// GET /api/purchases/sales-typeahead
//   q              required for typeahead; for IMEI/barcode scan, exact-match path
//   limit          default 20, max 50
//   pricingGroupId optional — applies VariantGroupPrice / ProductGroupPrice
//   locationId     optional — restrict items.sendTo
//   includeSerial  default true; "0" to skip serial rows (non-serial-only)
//   includeNonSerial default true; "0" to skip non-serial rows
// ──────────────────────────────────────────────────────────────────────────────

// Per-tenant 5-second cache for the sold-serial set (typeahead reuses across keystrokes)
const _typeaheadSoldCache = new Map();
const TYPEAHEAD_SOLD_TTL = 5_000;
async function getCachedSoldSet(tenantId) {
    const entry = _typeaheadSoldCache.get(tenantId);
    if (entry && Date.now() - entry.ts < TYPEAHEAD_SOLD_TTL) return entry.set;
    const list = await distinctSerialNumbersSoldOnActiveSales();
    const set = new Set((list || []).map((s) => String(s).trim()));
    _typeaheadSoldCache.set(tenantId, { set, ts: Date.now() });
    return set;
}

// 8-second LRU response cache for typeahead. Backspace/retype the same query → instant.
const _typeaheadResponseCache = new Map(); // key → { body, ts }
const TYPEAHEAD_RESPONSE_TTL = 8_000;
const TYPEAHEAD_RESPONSE_MAX = 500;
function _taKey(tenantId, q, limit, pricingGroupId, locationId, includeSerial, includeNonSerial) {
    return `${tenantId}|${q.toLowerCase()}|${limit}|${pricingGroupId || ''}|${locationId || ''}|${includeSerial ? 1 : 0}|${includeNonSerial ? 1 : 0}`;
}
function _taGet(key) {
    const e = _typeaheadResponseCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > TYPEAHEAD_RESPONSE_TTL) { _typeaheadResponseCache.delete(key); return null; }
    // LRU touch: re-insert to move to most-recent position
    _typeaheadResponseCache.delete(key);
    _typeaheadResponseCache.set(key, e);
    return e.body;
}
function _taSet(key, body) {
    _typeaheadResponseCache.set(key, { body, ts: Date.now() });
    // Evict oldest if over cap
    while (_typeaheadResponseCache.size > TYPEAHEAD_RESPONSE_MAX) {
        const firstKey = _typeaheadResponseCache.keys().next().value;
        _typeaheadResponseCache.delete(firstKey);
    }
}
/** Drop cache for a tenant after writes that change inventory (sale/purchase/return). */
function invalidateTypeaheadCache(tenantId) {
    for (const k of _typeaheadResponseCache.keys()) {
        if (k.startsWith(tenantId + '|')) _typeaheadResponseCache.delete(k);
    }
    _typeaheadSoldCache.delete(tenantId);
}
exports.invalidateTypeaheadCache = invalidateTypeaheadCache;
exports.invalidateForSalesCache = invalidateForSalesCache;
exports.invalidateInventoryListCaches = invalidateInventoryListCaches;

/** True when the term looks like a scanned IMEI/serial/barcode (≥7 alphanumeric, mostly digits). */
function looksLikeSerialBarcode(term) {
    if (!term) return false;
    const t = String(term).trim();
    if (t.length < 5) return false;
    return /^[A-Za-z0-9-]+$/.test(t);
}

/**
 * Fast typeahead path backed by the denormalized StockItem collection.
 * Returns null if it can't satisfy the request (caller falls back to aggregation).
 *
 * Latency target: ~10–50 ms (single index-backed find + small in-memory shaping).
 */
async function runStockItemTypeahead({
    tenantId, q, limit, pricingGroupId, locationId,
    includeSerial, includeNonSerial, t0
}) {
    const trimmed = q.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRegex = new RegExp('^' + escaped, 'i');
    const isScan = looksLikeSerialBarcode(trimmed);

    const baseFilter = { tenantId, status: 'in_stock' };
    if (locationId) baseFilter.sendTo = new (require('mongoose').Types.ObjectId)(locationId);
    if (!includeSerial && !includeNonSerial) return { success: true, count: 0, data: [], tookMs: Date.now() - t0 };
    if (!includeSerial) baseFilter.isSerial = false;
    if (!includeNonSerial) baseFilter.isSerial = true;

    let docs = [];
    if (isScan) {
        // Scan path: try exact IMEI first, then prefix on barcode/name. Each is index-backed.
        const exactImei = await StockItem.find({ ...baseFilter, imei: trimmed })
            .limit(limit)
            .lean();
        if (exactImei.length > 0) {
            docs = exactImei;
        } else {
            docs = await StockItem.find({
                ...baseFilter,
                $or: [
                    { barcode: prefixRegex },
                    { name: prefixRegex },
                    { imei: prefixRegex }
                ]
            })
                .sort({ inventoryDate: -1 })
                .limit(limit)
                .lean();
        }
    } else {
        // Typeahead path: case-insensitive substring on the lowercased searchText blob.
        // searchText is single-field indexed (B-tree), so a prefix regex is fast.
        // For non-anchored substring we do a contains regex over searchText too;
        // collection is small enough (one row per IMEI/non-serial item) that this is sub-50ms.
        const containsRegex = new RegExp(escaped);  // searchText is already lowercase, no /i needed
        docs = await StockItem.find({
            ...baseFilter,
            searchText: { $regex: containsRegex }
        })
            .sort({ inventoryDate: -1 })
            .limit(limit)
            .lean();
    }

    const rows = docs.map((d) => ({
        rowKey: d.isSerial && d.imei
            ? `${d.purchaseId}-${d.purchaseItemId}-${d.imei}`
            : `${d.purchaseId}-${d.purchaseItemId}-no-imei`,
        name: d.name || '',
        barcode: d.barcode || '',
        category: d.category || '',
        categoryId: d.categoryId || null,
        brand: d.brand || '',
        brandModel: d.brandModel || '',
        grade: d.grade || '',
        capacity: d.capacity || '',
        colour: d.colour || '',
        variantValues: d.variantValues || [],
        salePrice: Number(d.salePrice) || 0,
        purchasePrice: Number(d.purchasePrice) || 0,
        currency: d.currency || 'GBP',
        imei: d.imei || '-',
        quantity: d.isSerial ? 1 : (Number(d.quantity) || 1),
        purchaseId: String(d.purchaseId),
        purchaseItemId: String(d.purchaseItemId),
        inventoryDate: d.inventoryDate || null,
        isSerial: !!d.isSerial
    }));

    // Customer-group pricing on the bounded result set only.
    if (pricingGroupId && rows.length > 0) {
        const wrapper = [{ items: rows.map((r) => ({
            barcode: r.barcode, category: r.category, grade: r.grade,
            brand: r.brand, brandModel: r.brandModel, capacity: r.capacity,
            salePrice: r.salePrice, _row: r
        })) }];
        await resolveGroupPricesForPurchases(wrapper, tenantId, pricingGroupId);
        wrapper[0].items.forEach((it) => {
            if (it._row && it.salePrice != null) it._row.salePrice = Number(it.salePrice) || 0;
        });
    }

    return {
        success: true,
        count: rows.length,
        data: rows,
        tookMs: Date.now() - t0
    };
}

exports.salesTypeahead = asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const tenantId = getTenantIdFromReq(req);
    const q = (req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const pricingGroupId = req.query.pricingGroupId || null;
    const locationId = req.query.locationId || null;
    const includeSerial = req.query.includeSerial !== '0';
    const includeNonSerial = req.query.includeNonSerial !== '0';

    if (!q) {
        return res.status(200).json({ success: true, count: 0, data: [], tookMs: 0 });
    }

    // Check response cache first — backspace/retype the same query returns instantly.
    const responseKey = _taKey(tenantId, q, limit, pricingGroupId, locationId, includeSerial, includeNonSerial);
    const cachedBody = _taGet(responseKey);
    if (cachedBody) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Server-Timing', `total;dur=${Date.now() - t0}`);
        return res.status(200).json(cachedBody);
    }

    // ── Fast path: query the denormalized StockItem index. Falls back to the
    // legacy aggregation only when StockItem has zero rows for the tenant
    // (e.g. backfill not run yet).
    try {
        const stockItemCount = await StockItem.estimatedDocumentCount();
        if (stockItemCount > 0) {
            const fastBody = await runStockItemTypeahead({
                tenantId, q, limit, pricingGroupId, locationId,
                includeSerial, includeNonSerial, t0
            });
            if (fastBody) {
                _taSet(responseKey, fastBody);
                res.setHeader('Server-Timing', `total;dur=${Date.now() - t0}`);
                res.setHeader('X-Cache', 'MISS');
                res.setHeader('X-Source', 'stock_items');
                return res.status(200).json(fastBody);
            }
        }
    } catch (err) {
        console.error('[salesTypeahead] StockItem fast path failed, falling back:', err.message);
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Anchor for fast prefix scan on indexed fields
    const prefixRegex = new RegExp('^' + escaped, 'i');
    const containsRegex = new RegExp(escaped, 'i');
    const isScan = looksLikeSerialBarcode(q);

    // Stage 1: $match — narrow purchases to those with at least one item that could match.
    // Cheap: uses tenantId index + multikey indexes on items.imeis / items.barcode / items.brand etc.
    const itemMatchOr = [];
    if (isScan) {
        // Scan path: prefer exact / prefix match on indexed fields
        itemMatchOr.push({ 'items.imeis': q });
        itemMatchOr.push({ 'items.barcode': prefixRegex });
        itemMatchOr.push({ 'items.name': prefixRegex });
    } else {
        itemMatchOr.push({ 'items.brand': containsRegex });
        itemMatchOr.push({ 'items.brandModel': containsRegex });
        itemMatchOr.push({ 'items.name': containsRegex });
        itemMatchOr.push({ 'items.barcode': containsRegex });
        itemMatchOr.push({ 'items.capacity': containsRegex });
        itemMatchOr.push({ 'items.colour': containsRegex });
        itemMatchOr.push({ 'items.grade': containsRegex });
        itemMatchOr.push({ 'items.variantValues.value': containsRegex });
    }

    const purchaseMatch = { tenantId, items: { $elemMatch: { $or: itemMatchOr } } };

    // Stage 2: aggregate — unwind items, re-filter, project minimal fields.
    const pipeline = [
        { $match: purchaseMatch },
        // Sort purchases newest-first so most recent stock surfaces first
        { $sort: { createdAt: -1 } },
        { $unwind: '$items' },
        // Re-apply the same filter post-unwind so we keep only matching items
        {
            $match: {
                $or: [
                    ...(isScan
                        ? [
                              { 'items.imeis': q },
                              { 'items.barcode': prefixRegex },
                              { 'items.name': prefixRegex }
                          ]
                        : [
                              { 'items.brand': containsRegex },
                              { 'items.brandModel': containsRegex },
                              { 'items.name': containsRegex },
                              { 'items.barcode': containsRegex },
                              { 'items.capacity': containsRegex },
                              { 'items.colour': containsRegex },
                              { 'items.grade': containsRegex },
                              { 'items.variantValues.value': containsRegex }
                          ])
                ]
            }
        },
        // Optional location filter — applied post-unwind so per-item sendTo is honoured
        ...(locationId
            ? [{ $match: { 'items.sendTo': new (require('mongoose').Types.ObjectId)(locationId) } }]
            : []),
        // Filter by serial / non-serial inclusion early to avoid extra work
        ...(!includeSerial || !includeNonSerial
            ? [
                  {
                      $match:
                          !includeSerial
                              ? {
                                    $or: [
                                        { 'items.isOtherItem': true },
                                        { 'items.imeis': { $exists: false } },
                                        { 'items.imeis': { $size: 0 } }
                                    ]
                                }
                              : {
                                    'items.imeis.0': { $exists: true },
                                    'items.isOtherItem': { $ne: true }
                                }
                  }
              ]
            : []),
        // Resolve category name (one $lookup over a small set after unwind+match+limit window)
        {
            $lookup: {
                from: 'categories',
                let: { catId: '$items.category' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$_id', '$$catId'] } } },
                    { $project: { name: 1 } }
                ],
                as: '_cat'
            }
        },
        {
            $project: {
                _id: 0,
                purchaseId: '$_id',
                purchaseItemId: '$items._id',
                inventoryDate: '$date',
                createdAt: 1,
                currency: '$currency',
                categoryId: '$items.category',
                categoryName: { $ifNull: [{ $arrayElemAt: ['$_cat.name', 0] }, ''] },
                name: '$items.name',
                barcode: '$items.barcode',
                brand: '$items.brand',
                brandModel: '$items.brandModel',
                capacity: '$items.capacity',
                colour: '$items.colour',
                grade: '$items.grade',
                variantValues: '$items.variantValues',
                purchasePrice: '$items.purchasePrice',
                salePrice: '$items.salePrice',
                imeis: { $ifNull: ['$items.imeis', []] },
                quantity: { $ifNull: ['$items.quantity', 1] },
                isOtherItem: { $ifNull: ['$items.isOtherItem', false] },
                sendTo: '$items.sendTo'
            }
        },
        // Cap at 4× requested limit before fan-out so we have headroom after sold-IMEI exclusion
        { $limit: limit * 4 }
    ];

    const tQuery = Date.now();
    const [items, soldSet] = await Promise.all([
        Purchase.aggregate(pipeline),
        getCachedSoldSet(tenantId)
    ]);
    const tQueryDone = Date.now();

    // Fan out: one row per IMEI for serial items, single row for non-serial items.
    const rows = [];
    for (const it of items) {
        const isSerial = !it.isOtherItem && Array.isArray(it.imeis) && it.imeis.length > 0;
        if (isSerial) {
            for (const rawImei of it.imeis) {
                const imei = String(rawImei || '').trim();
                if (!imei || soldSet.has(imei)) continue;
                rows.push({
                    rowKey: `${it.purchaseId}-${it.purchaseItemId}-${imei}`,
                    name: it.name,
                    barcode: it.barcode,
                    category: it.categoryName,
                    categoryId: it.categoryId,
                    brand: it.brand || '',
                    brandModel: it.brandModel || '',
                    grade: it.grade || '',
                    capacity: it.capacity || '',
                    colour: it.colour || '',
                    variantValues: it.variantValues || [],
                    salePrice: Number(it.salePrice) || 0,
                    purchasePrice: Number(it.purchasePrice) || 0,
                    currency: it.currency || 'GBP',
                    imei,
                    quantity: 1,
                    purchaseId: String(it.purchaseId),
                    purchaseItemId: String(it.purchaseItemId),
                    inventoryDate: it.inventoryDate,
                    isSerial: true
                });
                if (rows.length >= limit) break;
            }
        } else {
            // Non-serial row
            rows.push({
                rowKey: `${it.purchaseId}-${it.purchaseItemId}-no-imei`,
                name: it.name,
                barcode: it.barcode,
                category: it.categoryName,
                categoryId: it.categoryId,
                brand: it.brand || '',
                brandModel: it.brandModel || '',
                grade: it.grade || '',
                capacity: it.capacity || '',
                colour: it.colour || '',
                variantValues: it.variantValues || [],
                salePrice: Number(it.salePrice) || 0,
                purchasePrice: Number(it.purchasePrice) || 0,
                currency: it.currency || 'GBP',
                imei: '-',
                quantity: Number(it.quantity) || 1,
                purchaseId: String(it.purchaseId),
                purchaseItemId: String(it.purchaseItemId),
                inventoryDate: it.inventoryDate,
                isSerial: false
            });
        }
        if (rows.length >= limit) break;
    }

    // Customer-group pricing for matched rows only (cheap — bounded by `limit`)
    if (pricingGroupId && rows.length > 0) {
        // Build minimal "purchase-like" wrapper compatible with resolveGroupPricesForPurchases
        const wrapper = [
            {
                items: rows.map((r) => ({
                    barcode: r.barcode,
                    category: r.category,
                    grade: r.grade,
                    brand: r.brand,
                    brandModel: r.brandModel,
                    capacity: r.capacity,
                    salePrice: r.salePrice,
                    _row: r
                }))
            }
        ];
        await resolveGroupPricesForPurchases(wrapper, tenantId, pricingGroupId);
        wrapper[0].items.forEach((it) => {
            if (it._row && it.salePrice != null) it._row.salePrice = Number(it.salePrice) || 0;
        });
    }

    const tookMs = Date.now() - t0;
    const responseBody = {
        success: true,
        count: rows.length,
        data: rows,
        tookMs
    };
    _taSet(responseKey, responseBody);
    res.setHeader('Server-Timing', `agg;dur=${tQueryDone - tQuery}, total;dur=${tookMs}`);
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(responseBody);
});

exports.getNonSerialStockRowsForTransfer = getNonSerialStockRowsForTransfer;
/** Re-resolve in-stock state after void/hard-delete (SoldSerial removed; SerialIndex must match). */
exports.legacyFindInStockSerials = legacyFindInStockSerials;
