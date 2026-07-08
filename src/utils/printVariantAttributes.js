const Product = require('../models/Product');

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
    const products = await Product.find({ tenantId: tid, sku: { $in: skus } })
        .select('sku category')
        .populate({
            path: 'category',
            select: 'name variantAttributes',
            populate: { path: 'variantAttributes', select: 'slug' }
        })
        .lean();
    for (const p of products) {
        if (!p.sku) continue;
        const cat = p.category;
        if (cat && cat.name && String(cat.name).trim()) {
            categoryNameBySku[p.sku] = String(cat.name).trim();
        }
        const attrs = cat && Array.isArray(cat.variantAttributes) ? cat.variantAttributes : [];
        const slugs = attrs
            .map((a) => (a && a.slug ? String(a.slug).trim().toLowerCase() : ''))
            .filter(Boolean);
        if (slugs.length) variantAttributeSlugsOrderBySku[p.sku] = slugs;
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

module.exports = { printMapsForSale, variantAttributeSlugsOrderBySkuForSale };
