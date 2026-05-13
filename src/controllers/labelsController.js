/**
 * Label/QR data for print module: products, serials resolve, locations.
 * All routes require inventory.print_labels.
 */

const asyncHandler = require('../middleware/asyncHandler');
const Product = require('../models/Product');
const SerialLocation = require('../models/SerialLocation');
const Location = require('../models/Location');
const Purchase = require('../models/Purchase');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');

function normalizeSerial(s) {
    return (s && String(s).trim()) || '';
}

function slugKey(s) {
    return (s && String(s).trim().toLowerCase()) || '';
}

/**
 * Build variant text in Edit Category order (category.variantAttributes array order).
 * Joins values with spaces only (no middle dots).
 */
function variantDisplayOrdered(variantValues, cat) {
    const vv = Array.isArray(variantValues) ? variantValues : [];
    if (!cat || !Array.isArray(cat.variantAttributes) || cat.variantAttributes.length === 0) {
        return vv
            .map((x) => (x && x.value != null ? String(x.value).trim() : ''))
            .filter(Boolean)
            .join(' ');
    }
    const order = cat.variantAttributes.map((a) => slugKey(a.slug || a.name));
    const bySlug = new Map();
    for (const x of vv) {
        const k = slugKey(x.slug);
        if (k) bySlug.set(k, x);
    }
    const out = [];
    const used = new Set();
    for (const k of order) {
        const x = bySlug.get(k);
        if (x && x.value != null && String(x.value).trim()) {
            out.push(String(x.value).trim());
            used.add(k);
        }
    }
    for (const x of vv) {
        const k = slugKey(x.slug);
        if (used.has(k)) continue;
        if (x && x.value != null && String(x.value).trim()) out.push(String(x.value).trim());
    }
    return out.join(' ');
}

// GET /api/labels/products?q=&full=1
// Returns products and, when q is set, also parcel (purchase) non-serial items matching by barcode/name so the barcode entered when adding the parcel is used for QR/labels.
exports.getLabelProducts = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const q = (req.query.q || '').toString().trim();
    const full = req.query.full === '1' || req.query.full === 'true';
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const query = { tenantId, isActive: true };
    if (q) {
        query.$or = [
            { name: { $regex: q, $options: 'i' } },
            { sku: { $regex: q, $options: 'i' } },
            { barcode: q }
        ];
    }
    const select = '_id name sku barcode sellingPrice costPrice minStockLevel lowStockThreshold category';
    const categoryPopulate = full
        ? { path: 'category', select: 'name variantAttributes', populate: { path: 'variantAttributes', select: 'name slug' } }
        : { path: 'category', select: 'name' };
    const products = await Product.find(query)
        .select(select)
        .populate(categoryPopulate)
        .lean();

    const productRows = products.map((p) => {
        const out = {
            productId: p._id,
            name: p.name,
            sku: p.sku,
            barcode: p.barcode,
            salePrice: p.sellingPrice,
            costPrice: p.costPrice,
            lowStockThreshold: p.lowStockThreshold,
            minStockLevel: p.minStockLevel
        };
        if (p.category && p.category.name) {
            out.categoryName = p.category.name;
        }
        if (full && p.category && Array.isArray(p.category.variantAttributes)) {
            out.variantAttributes = p.category.variantAttributes.map((a) => ({ name: a.name, slug: a.slug }));
        }
        return out;
    });
    const productBarcodes = new Set(productRows.map((d) => d.barcode).filter(Boolean));

    // When searching, include non-serial parcel (purchase) items by barcode or name so the barcode entered when adding the parcel is used for labels. Put them first so search-by-barcode finds the parcel item. Include category and variant from the purchase item so they match what was entered in the parcel form.
    const parcelRows = [];
    if (q) {
        const purchaseMatch = {
            tenantId,
            $or: [
                { 'items.barcode': q },
                { 'items.name': { $regex: q, $options: 'i' } }
            ]
        };
        const purchases = await Purchase.find(purchaseMatch)
            .select('_id items')
            .populate(full
                ? { path: 'items.category', select: 'name variantAttributes', populate: { path: 'variantAttributes', select: 'name slug' } }
                : { path: 'items.category', select: 'name' })
            .lean();
        const seen = new Set();
        for (const purchase of purchases) {
            const items = purchase.items || [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const imeis = Array.isArray(item.imeis) ? item.imeis : [];
                const isNonSerial = imeis.length === 0 || item.isOtherItem === true;
                if (!isNonSerial) continue;
                const barcode = item.barcode ? String(item.barcode).trim() : null;
                if (barcode && productBarcodes.has(barcode)) continue;
                const name = item.name ? String(item.name).trim() : null;
                if (!name && !barcode) continue;
                const key = `${purchase._id}-${item._id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const cat = item.category;
                const categoryName = (cat && cat.name) ? cat.name : null;
                const variantAttributes = (full && cat && Array.isArray(cat.variantAttributes))
                    ? cat.variantAttributes.map((a) => ({ name: a.name || a.slug, slug: a.slug || a.name }))
                    : undefined;
                const vv = Array.isArray(item.variantValues) ? item.variantValues : [];
                const variantDisplay = variantDisplayOrdered(vv, cat) || null;
                const row = {
                    productId: `purchase-${purchase._id}-${item._id}`,
                    name: name || barcode || 'Item',
                    sku: barcode || name || '',
                    barcode: barcode || null,
                    salePrice: item.salePrice != null ? Number(item.salePrice) : null,
                    costPrice: item.purchasePrice != null ? Number(item.purchasePrice) : null,
                    lowStockThreshold: null,
                    minStockLevel: null
                };
                if (categoryName) row.categoryName = categoryName;
                if (variantDisplay) row.variantDisplay = variantDisplay;
                if (variantAttributes && variantAttributes.length) row.variantAttributes = variantAttributes;
                parcelRows.push(row);
            }
        }
    }

    const data = [...parcelRows, ...productRows].slice(0, limit);
    res.json({ success: true, data });
});

// POST /api/labels/serials/resolve  body: { serials: string[] }
exports.resolveSerials = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const serials = Array.isArray(req.body.serials) ? req.body.serials : [];
    const normalized = serials.map((s) => normalizeSerial(s)).filter(Boolean);
    const unique = [...new Set(normalized)];

    const results = [];
    for (const serial of unique) {
        const sl = await SerialLocation.findOne({ tenantId, serialNumber: serial })
            .populate({
                path: 'productId',
                select: 'name sku barcode category',
                populate: { path: 'category', select: 'name' }
            })
            .populate('locationId', 'name type')
            .lean();
        if (sl) {
            const status = sl.status || 'available';
            const invalidReason = status === 'adjusted_out' ? 'Adjusted out' : null;
            const categoryName = sl.productId?.category?.name || null;
            // Look up purchase to get variantValues for display-order label title
            let variantDisplay = null;
            let purchaseId = null;
            let purchasePrice = null;
            const purchaseForSl = await Purchase.findOne({ tenantId, 'items.imeis': serial })
                .select('_id items')
                .populate({
                    path: 'items.category',
                    select: 'name variantAttributes',
                    populate: { path: 'variantAttributes', select: 'name slug' }
                })
                .lean();
            if (purchaseForSl) {
                const slItem = (purchaseForSl.items || []).find((i) => (i.imeis || []).map((x) => String(x).trim()).includes(serial));
                if (slItem) {
                    const vv = Array.isArray(slItem.variantValues) ? slItem.variantValues : [];
                    variantDisplay = variantDisplayOrdered(vv, slItem.category) || null;
                    purchaseId = purchaseForSl._id;
                    purchasePrice = slItem.purchasePrice ?? null;
                }
            }
            results.push({
                serial,
                productId: sl.productId?._id || null,
                productName: sl.productId?.name || null,
                sku: sl.productId?.sku || null,
                barcode: sl.productId?.barcode || null,
                categoryName,
                variantDisplay,
                locationId: sl.locationId?._id || null,
                locationName: sl.locationId?.name || null,
                status,
                purchaseId,
                purchasePrice,
                found: true,
                invalidReason
            });
            continue;
        }
        const purchaseDoc = await Purchase.findOne({ tenantId, 'items.imeis': serial })
            .select('items purchaseNumber')
            .populate({
                path: 'items.category',
                select: 'name variantAttributes',
                populate: { path: 'variantAttributes', select: 'name slug' }
            })
            .lean();
        if (purchaseDoc) {
            const item = (purchaseDoc.items || []).find((i) => (i.imeis || []).map((x) => String(x).trim()).includes(serial));
            const purchasePrice = item?.purchasePrice ?? null;
            const productName = item?.name || item?.brandModel || null;
            const itemBarcode = item?.barcode ? String(item.barcode).trim() : null;
            const cat = item?.category;
            const categoryName = (cat && cat.name) ? cat.name : null;
            const vv = Array.isArray(item?.variantValues) ? item.variantValues : [];
            const variantDisplay = variantDisplayOrdered(vv, cat) || null;
            results.push({
                serial,
                productId: null,
                productName,
                sku: itemBarcode || null,
                barcode: itemBarcode,
                categoryName,
                variantDisplay: variantDisplay || null,
                locationId: null,
                locationName: null,
                status: 'in_purchase',
                purchaseId: purchaseDoc._id,
                purchasePrice,
                found: true,
                invalidReason: null
            });
            continue;
        }
        results.push({
            serial,
            productId: null,
            productName: null,
            sku: null,
            categoryName: null,
            variantDisplay: null,
            locationId: null,
            locationName: null,
            status: null,
            purchaseId: null,
            purchasePrice: null,
            found: false,
            invalidReason: 'Not found in stock or purchases'
        });
    }
    res.json({ success: true, data: results });
});

// GET /api/labels/locations
exports.getLabelLocations = asyncHandler(async (req, res) => {
    const locations = await Location.find({ isActive: true })
        .select('_id name type')
        .sort('name')
        .lean();
    res.json({
        success: true,
        data: locations.map((l) => ({ locationId: l._id, name: l.name, type: l.type }))
    });
});

// POST /api/labels/log-print  body: { type, counts, template }
exports.logLabelsPrinted = asyncHandler(async (req, res) => {
    const { type, counts, template } = req.body || {};
    await activityLogService.logFromReq(req, {
        action: 'LABELS_PRINTED',
        entityType: 'Other',
        entityId: null,
        success: true,
        message: `Labels printed: ${type} (${JSON.stringify(counts || {})})`,
        metaJson: { type, counts: counts || {}, template: template || null }
    });
    res.json({ success: true });
});
