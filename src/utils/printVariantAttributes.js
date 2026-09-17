const Product = require('../models/Product');
const Purchase = require('../models/Purchase');

/** POS inventory line SKU: purchaseId-itemId-no-imei or purchaseId-itemId-serial */
const PURCHASE_LINE_SKU_RE = /^([a-f0-9]{24})-([a-f0-9]{24})-(no-imei|.+)$/i;

function parsePurchaseLineSku(sku) {
    const m = String(sku || '').trim().match(PURCHASE_LINE_SKU_RE);
    if (!m) return null;
    return { purchaseId: m[1], itemId: m[2] };
}

function applyCategoryMapsFromPopulatedCategory(
    cat,
    sku,
    categoryNameBySku,
    variantAttributeSlugsOrderBySku
) {
    if (!sku) return;
    if (cat && cat.name && String(cat.name).trim()) {
        categoryNameBySku[sku] = String(cat.name).trim();
    }
    const attrs = cat && Array.isArray(cat.variantAttributes) ? cat.variantAttributes : [];
    const slugs = attrs
        .map((a) => (a && a.slug ? String(a.slug).trim().toLowerCase() : ''))
        .filter(Boolean);
    if (slugs.length) variantAttributeSlugsOrderBySku[sku] = slugs;
}

/**
 * SKU → variant slugs + category names for receipt/invoice print (Product → Category).
 * @param {object} sale - lean Sale with items[].sku, tenantId
 * @param {string} tenantId - from req when sale.tenantId missing
 * @returns {Promise<{ variantAttributeSlugsOrderBySku: Record<string, string[]>, categoryNameBySku: Record<string, string> }>}
 */
async function printMapsForSale(sale, tenantId) {
    const variantAttributeSlugsOrderBySku = {};
    const categoryNameBySku = {};
    const tid = (sale.tenantId && String(sale.tenantId).trim()) || tenantId;
    const skus = [...new Set((sale.items || []).map((i) => i.sku).filter(Boolean))];
    if (skus.length === 0) {
        return { variantAttributeSlugsOrderBySku, categoryNameBySku };
    }

    const catalogSkus = [];
    const purchaseRefs = [];
    for (const sku of skus) {
        const parsed = parsePurchaseLineSku(sku);
        if (parsed) purchaseRefs.push({ sku, ...parsed });
        else catalogSkus.push(sku);
    }

    const categoryPopulate = {
        path: 'category',
        select: 'name variantAttributes',
        populate: { path: 'variantAttributes', select: 'slug' }
    };

    if (catalogSkus.length > 0) {
        const products = await Product.find({ tenantId: tid, sku: { $in: catalogSkus } })
            .select('sku category')
            .populate(categoryPopulate)
            .lean();
        for (const p of products) {
            if (!p.sku) continue;
            applyCategoryMapsFromPopulatedCategory(
                p.category,
                p.sku,
                categoryNameBySku,
                variantAttributeSlugsOrderBySku
            );
        }
    }

    if (purchaseRefs.length > 0) {
        const purchaseIds = [...new Set(purchaseRefs.map((r) => r.purchaseId))];
        const purchases = await Purchase.find({ tenantId: tid, _id: { $in: purchaseIds } })
            .select('items._id items.category')
            .populate({
                path: 'items.category',
                select: 'name variantAttributes',
                populate: { path: 'variantAttributes', select: 'slug' }
            })
            .lean();
        const purchaseById = new Map(purchases.map((p) => [String(p._id), p]));
        for (const { sku, purchaseId, itemId } of purchaseRefs) {
            const purchase = purchaseById.get(String(purchaseId));
            if (!purchase) continue;
            const line = (purchase.items || []).find((i) => String(i._id) === String(itemId));
            if (!line) continue;
            applyCategoryMapsFromPopulatedCategory(
                line.category,
                sku,
                categoryNameBySku,
                variantAttributeSlugsOrderBySku
            );
        }
    }

    return { variantAttributeSlugsOrderBySku, categoryNameBySku };
}

/**
 * SKU → variant attribute slugs in Edit Category order (Product → Category.variantAttributes).
 * @param {object} sale - lean Sale with items[].sku, tenantId
 * @param {string} tenantId - from req when sale.tenantId missing
 * @returns {Promise<Record<string, string[]>>}
 */
async function variantAttributeSlugsOrderBySkuForSale(sale, tenantId) {
    const { variantAttributeSlugsOrderBySku } = await printMapsForSale(sale, tenantId);
    return variantAttributeSlugsOrderBySku;
}

module.exports = {
    printMapsForSale,
    variantAttributeSlugsOrderBySkuForSale,
    parsePurchaseLineSku,
    PURCHASE_LINE_SKU_RE
};
