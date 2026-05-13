/**
 * Low stocks: available qty from StockBalance (qty) and SerialLocation (serialized).
 * effectiveThreshold = product.lowStockThreshold ?? settings.defaultLowStockThreshold ?? 5.
 * Include row when availableQty <= thresholdUsed.
 */

const asyncHandler = require('../middleware/asyncHandler');
const Product = require('../models/Product');
const StockBalance = require('../models/StockBalance');
const SerialLocation = require('../models/SerialLocation');
const InventorySettings = require('../models/InventorySettings');
const { formatSupplierLabel } = require('../utils/supplierDisplay');
const { getTenantIdFromReq } = require('../middleware/auth');
const { makeSwrCache } = require('../utils/swrCache');
const cache = require('../lib/cache');

const DEFAULT_THRESHOLD = 5;

// SWR cache for low-stocks. Keyed by (tenant, locationId, q, categoryId, supplierId, requestThreshold).
// Page/limit aren't part of the key — we cache the full computed row set per filter combo and slice in memory.
// Stock counts change with every sale/purchase; keep freshness short so users see updates promptly.
const _lowStocksCache = makeSwrCache({ freshMs: 20_000, maxStaleMs: 5 * 60_000 });
// Invalidate both the in-process SWR cache and the cross-instance Redis namespace bump.
// Optional tenantId scopes the Redis bump; SWR is process-local so scope doesn't apply.
exports._invalidateLowStocksCache = (tenantId) => {
    _lowStocksCache.invalidate(null);
    // Fire and forget; the SWR invalidation is sync, the Redis bump is async.
    Promise.resolve(cache.bumpNs('products:lowStock', tenantId)).catch(() => {});
};

function can(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissionKeys && user.permissionKeys.has(key);
}

/**
 * Compute low-stock rows. Shared by GET /api/inventory/low-stocks and the dashboard widget,
 * so both surfaces show identical numbers (StockBalance + SerialLocation, per-product threshold).
 */
async function computeLowStockRows({ locationId = null, requestThreshold = null, q = null, categoryId = null, supplierId = null } = {}) {
        const productMatch = { isActive: true };
        if (categoryId) productMatch.category = categoryId;
        if (supplierId) productMatch.supplier = supplierId;
        if (q) {
            productMatch.$or = [
                { name: new RegExp(q, 'i') },
                { sku: new RegExp(q, 'i') },
                { barcode: q }
            ];
        }

        const [settings, products] = await Promise.all([
            InventorySettings.getSettings(),
            Product.find(productMatch)
                .select('_id name sku category lowStockThreshold reorderQtyDefault minStockLevel supplier')
                .populate('category', 'name itemType')
                .populate('supplier', 'name contactPerson')
                .lean()
        ]);

        const defaultThreshold = (settings && settings.defaultLowStockThreshold != null)
            ? Number(settings.defaultLowStockThreshold)
            : DEFAULT_THRESHOLD;

        const productIds = products.map((p) => p._id);
        const balanceFilter = { productId: { $in: productIds } };
        if (locationId) balanceFilter.locationId = locationId;
        const serialFilter = { productId: { $in: productIds }, status: 'available' };
        if (locationId) serialFilter.locationId = locationId;

        const [balanceAgg, serialAgg] = await Promise.all([
            StockBalance.aggregate([
                { $match: balanceFilter },
                { $group: { _id: { productId: '$productId', locationId: '$locationId' }, total: { $sum: '$quantity' } } }
            ]),
            SerialLocation.aggregate([
                { $match: serialFilter },
                { $group: { _id: { productId: '$productId', locationId: '$locationId' }, count: { $sum: 1 } } }
            ])
        ]);

        const balanceMap = new Map();
        for (const row of balanceAgg) {
            const pid = row._id.productId.toString();
            const loc = row._id.locationId ? row._id.locationId.toString() : '_';
            if (!balanceMap.has(pid)) balanceMap.set(pid, new Map());
            balanceMap.get(pid).set(loc, (balanceMap.get(pid).get(loc) || 0) + row.total);
        }
        const serialMap = new Map();
        for (const row of serialAgg) {
            const pid = row._id.productId ? row._id.productId.toString() : null;
            if (!pid) continue;
            const loc = row._id.locationId ? row._id.locationId.toString() : '_';
            if (!serialMap.has(pid)) serialMap.set(pid, new Map());
            serialMap.get(pid).set(loc, (serialMap.get(pid).get(loc) || 0) + row.count);
        }

        const rows = [];
        for (const p of products) {
            const pid = p._id.toString();
            const itemType = (p.category && p.category.itemType) || 'both';
            let balanceQty = 0;
            const byLocBalance = balanceMap.get(pid);
            if (byLocBalance) {
                if (locationId) balanceQty = byLocBalance.get(locationId) || byLocBalance.get('_') || 0;
                else balanceQty = Array.from(byLocBalance.values()).reduce((a, b) => a + b, 0);
            }
            let serialQty = 0;
            const byLocSerial = serialMap.get(pid);
            if (byLocSerial) {
                if (locationId) serialQty = byLocSerial.get(locationId) || byLocSerial.get('_') || 0;
                else serialQty = Array.from(byLocSerial.values()).reduce((a, b) => a + b, 0);
            }
            const availableQty = itemType === 'serial' ? serialQty : (itemType === 'non-serial' ? balanceQty : balanceQty + serialQty);
            const isSerialized = itemType === 'serial' || (itemType === 'both' && serialQty > 0);
            const effectiveThreshold = p.lowStockThreshold != null ? Number(p.lowStockThreshold) : defaultThreshold;
            const thresholdUsed = requestThreshold != null && !isNaN(requestThreshold) ? requestThreshold : effectiveThreshold;
            if (availableQty > thresholdUsed) continue;
            const reorderDefault = p.reorderQtyDefault != null ? Number(p.reorderQtyDefault) : 0;
            const suggestedReorderQty = Math.max(0, thresholdUsed - availableQty + reorderDefault);
            rows.push({
                productId: p._id,
                name: p.name,
                sku: p.sku,
                category: p.category,
                supplier: p.supplier ? { ...p.supplier, displayLabel: formatSupplierLabel(p.supplier) } : null,
                availableQty,
                thresholdUsed,
                effectiveThreshold,
                lowStockThreshold: p.lowStockThreshold,
                reorderQtyDefault: p.reorderQtyDefault,
                isSerialized,
                locationId: locationId || null,
                suggestedReorderQty,
                status: availableQty === 0 ? 'out_of_stock' : 'low'
            });
        }
        return { rows, defaultThreshold };
}

exports.computeLowStockRows = computeLowStockRows;

/**
 * GET /api/inventory/low-stocks
 * Query: locationId, threshold (override for request), q (search), categoryId, supplierId, page, limit
 */
exports.getLowStocks = asyncHandler(async (req, res) => {
    if (!can(req.user, 'product.view') && !can(req.user, 'stock.view')) {
        return res.status(403).json({ success: false, message: 'Not allowed to view low stocks' });
    }
    const locationId = (req.query.locationId || '').toString().trim() || null;
    const requestThreshold = req.query.threshold != null ? parseInt(req.query.threshold, 10) : null;
    const q = (req.query.q || '').toString().trim() || null;
    const categoryId = (req.query.categoryId || '').toString().trim() || null;
    const supplierId = (req.query.supplierId || '').toString().trim() || null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const tenantId = getTenantIdFromReq(req);
    const cacheKey = [tenantId || '_', locationId || '_', q || '_', categoryId || '_', supplierId || '_', requestThreshold == null ? '_' : requestThreshold].join('|');

    const fetcher = () => computeLowStockRows({ locationId, requestThreshold, q, categoryId, supplierId });

    const cached = _lowStocksCache.get(cacheKey);
    let result;
    if (cached) {
        result = cached.value;
        if (cached.isStale) _lowStocksCache.revalidate(cacheKey, fetcher);
    } else {
        result = await _lowStocksCache.fetch(cacheKey, fetcher);
    }

    const total = result.rows.length;
    const data = result.rows.slice(skip, skip + limit);

    res.json({
        success: true,
        data,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        defaultLowStockThreshold: result.defaultThreshold
    });
});
