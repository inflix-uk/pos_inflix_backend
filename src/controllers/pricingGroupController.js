const PricingGroup = require('../models/PricingGroup');
const ProductGroupPrice = require('../models/ProductGroupPrice');
const VariantGroupPrice = require('../models/VariantGroupPrice');
const Customer = require('../models/Customer');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { normalizeVariantKey } = require('../utils/variantKeyUtils');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const PRICING_GROUP_CACHE_NAMESPACES = ['pricingGroups:list'];
async function invalidatePricingGroupCaches(tenantId) {
    await cache.bumpMany(PRICING_GROUP_CACHE_NAMESPACES, tenantId);
}

// @desc    Get all pricing groups for tenant (with customer and product-price counts when requested)
// @route   GET /api/pricing-groups
// @access  Private
exports.getPricingGroups = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const withCounts = req.query.counts === '1' || req.query.counts === 'true';
    const params = { withCounts };

    const data = await cache.cached(
        { ns: 'pricingGroups:list', tenantId, params, ttlSec: TTL.REFERENCE },
        async () => {
            if (withCounts) {
                const groups = await PricingGroup.find({ tenantId }).sort('name').lean();
                const ids = groups.map((g) => g._id);
                const [customerCounts, productPriceCounts, variantPriceCounts] = await Promise.all([
                    Customer.aggregate([{ $match: { tenantId, pricingGroupId: { $in: ids } } }, { $group: { _id: '$pricingGroupId', count: { $sum: 1 } } }]),
                    ProductGroupPrice.aggregate([{ $match: { tenantId, pricingGroup: { $in: ids } } }, { $group: { _id: '$pricingGroup', count: { $sum: 1 } } }]),
                    VariantGroupPrice.aggregate([{ $match: { tenantId, pricingGroup: { $in: ids } } }, { $group: { _id: '$pricingGroup', count: { $sum: 1 } } }])
                ]);
                const custMap = {};
                customerCounts.forEach((c) => { custMap[c._id.toString()] = c.count; });
                const productPriceMap = {};
                productPriceCounts.forEach((p) => { productPriceMap[p._id.toString()] = p.count; });
                const variantPriceMap = {};
                variantPriceCounts.forEach((v) => { variantPriceMap[v._id.toString()] = v.count; });
                return groups.map((g) => ({
                    ...g,
                    customerCount: custMap[g._id.toString()] || 0,
                    productPriceCount: productPriceMap[g._id.toString()] || 0,
                    variantPriceCount: variantPriceMap[g._id.toString()] || 0
                }));
            }
            return await PricingGroup.find({ tenantId }).sort('name').lean();
        }
    );

    res.status(200).json({ success: true, data });
});

// @desc    Get single pricing group
// @route   GET /api/pricing-groups/:id
// @access  Private
exports.getPricingGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId }).lean();
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    res.status(200).json({ success: true, data: group });
});

// @desc    Create pricing group
// @route   POST /api/pricing-groups
// @access  Private
exports.createPricingGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = { ...req.body };
    if (body.tenantId !== undefined) delete body.tenantId;
    const name = (body.name || '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    const existing = await PricingGroup.findOne({ tenantId, name }).lean();
    if (existing) {
        return res.status(400).json({ success: false, message: 'A group with this name already exists' });
    }
    const group = await PricingGroup.create({ name, tenantId });
    await invalidatePricingGroupCaches(tenantId);
    res.status(201).json({
        success: true,
        message: 'Pricing group created',
        data: group
    });
});

// @desc    Update pricing group (name only)
// @route   PUT /api/pricing-groups/:id
// @access  Private
exports.updatePricingGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId });
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    const name = (req.body.name || '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    const existing = await PricingGroup.findOne({ tenantId, name, _id: { $ne: req.params.id } }).lean();
    if (existing) {
        return res.status(400).json({ success: false, message: 'A group with this name already exists' });
    }
    group.name = name;
    await group.save();
    await invalidatePricingGroupCaches(tenantId);
    res.status(200).json({ success: true, data: group, message: 'Pricing group updated' });
});

// @desc    Delete pricing group (unassigns customers, removes group prices, then deletes group)
// @route   DELETE /api/pricing-groups/:id
// @access  Private
exports.deletePricingGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId });
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    await Customer.updateMany({ tenantId, pricingGroupId: req.params.id }, { $set: { pricingGroupId: null } });
    await ProductGroupPrice.deleteMany({ tenantId, pricingGroup: req.params.id });
    await VariantGroupPrice.deleteMany({ tenantId, pricingGroup: req.params.id });
    await PricingGroup.deleteOne({ _id: req.params.id, tenantId });
    await invalidatePricingGroupCaches(tenantId);
    res.status(200).json({ success: true, message: 'Pricing group deleted' });
});

// @desc    Get product prices for this group (for rate list: productId -> price)
// @route   GET /api/pricing-groups/:id/product-prices
// @access  Private
exports.getProductPricesForGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    const list = await ProductGroupPrice.find({ tenantId, pricingGroup: req.params.id }).select('product price').lean();
    const data = list.map((gp) => ({ productId: gp.product.toString(), price: gp.price }));
    res.status(200).json({ success: true, data });
});

// @desc    Get variant prices for this group (Rate List: variantKey -> price)
// @route   GET /api/pricing-groups/:id/variant-prices
// @access  Private
exports.getVariantPricesForGroup = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    const list = await VariantGroupPrice.find({ tenantId, pricingGroup: req.params.id }).select('variantKey price').lean();
    const data = {};
    list.forEach((v) => { data[v.variantKey] = v.price; });
    res.status(200).json({ success: true, data });
});

// @desc    Set or remove one variant price for this group (Rate List save)
// @route   PUT /api/pricing-groups/:id/variant-prices
// @access  Private
exports.setVariantGroupPrice = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const group = await PricingGroup.findOne({ _id: req.params.id, tenantId });
    if (!group) {
        return res.status(404).json({ success: false, message: 'Pricing group not found' });
    }
    const variantKey = normalizeVariantKey(req.body.variantKey);
    if (!variantKey) {
        return res.status(400).json({ success: false, message: 'variantKey is required' });
    }
    const price = req.body.price;
    if (price == null || price === '' || (typeof price === 'number' && Number.isNaN(price))) {
        await VariantGroupPrice.deleteOne({ tenantId, pricingGroup: req.params.id, variantKey });
        return res.status(200).json({ success: true, message: 'Variant price removed' });
    }
    const num = Number(price);
    if (Number.isNaN(num) || num < 0) {
        return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
    }
    await VariantGroupPrice.findOneAndUpdate(
        { tenantId, pricingGroup: req.params.id, variantKey },
        { $set: { price: num } },
        { upsert: true, new: true }
    );
    res.status(200).json({ success: true, message: 'Variant price saved' });
});
