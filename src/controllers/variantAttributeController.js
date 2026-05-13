const mongoose = require('mongoose');
const VariantAttribute = require('../models/VariantAttribute');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { makeSwrCache } = require('../utils/swrCache');
const { checkVariantValueInUse, replaceVariantValueInPurchases } = require('../utils/variantValueUsage');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

// SWR cache for /api/variant-attributes list. Variant attributes change rarely; long fresh window is safe.
const _variantListCache = makeSwrCache({ freshMs: 60_000, maxStaleMs: 10 * 60_000 });
function _invalidateVariantListCache() { _variantListCache.invalidate(null); }
exports._invalidateVariantListCache = _invalidateVariantListCache;

// @desc    Get all variant attributes
// @route   GET /api/variant-attributes
// @access  Private
exports.getVariantAttributes = asyncHandler(async (req, res) => {
    const query = {};
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    if (req.query.isActive !== undefined) {
        query.isActive = req.query.isActive === 'true';
    }
    if (req.query.search) {
        query.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } }
        ];
    }

    // Sort: aggregation needs an object, not a string spec.
    let sortStage = { createdAt: -1 };
    switch (req.query.sort) {
        case 'oldest': sortStage = { createdAt: 1 }; break;
        case 'a-z': sortStage = { name: 1 }; break;
        case 'z-a': sortStage = { name: -1 }; break;
    }

    const tenantId = getTenantIdFromReq(req);
    const cacheKey = [
        tenantId || '_',
        page, limit,
        query.isActive == null ? '_' : (query.isActive ? '1' : '0'),
        req.query.search || '_',
        req.query.sort || '_'
    ].join('|');

    const redisParams = {
        page, limit,
        isActive: query.isActive == null ? null : !!query.isActive,
        search: req.query.search || null,
        sort: req.query.sort || null,
    };

    const dbFetcher = async () => {
        // $facet does count + paginated data in a single round trip (was 2 sequential queries).
        const [{ total: totalArr, data }] = await VariantAttribute.aggregate([
            { $match: query },
            {
                $facet: {
                    total: [{ $count: 'n' }],
                    data: [{ $sort: sortStage }, { $skip: skip }, { $limit: limit }]
                }
            }
        ]);
        const total = (totalArr && totalArr[0] && totalArr[0].n) || 0;
        return { data, total };
    };

    // Multi-instance share: Redis sits between dbFetcher and the in-memory SWR cache.
    const fetcher = async () => cache.cached(
        { ns: 'variantAttributes:list', tenantId, params: redisParams, ttlSec: TTL.CATALOG },
        dbFetcher
    );

    const cachedEntry = _variantListCache.get(cacheKey);
    let result;
    if (cachedEntry) {
        result = cachedEntry.value;
        if (cachedEntry.isStale) _variantListCache.revalidate(cacheKey, fetcher);
    } else {
        result = await _variantListCache.fetch(cacheKey, fetcher);
    }

    res.status(200).json({
        success: true,
        count: result.data.length,
        total: result.total,
        page,
        pages: Math.max(1, Math.ceil(result.total / limit)),
        data: result.data
    });
});

// @desc    Get single variant attribute by ID
// @route   GET /api/variant-attributes/:id
// @access  Private
exports.getVariantAttribute = asyncHandler(async (req, res) => {
    const variantAttribute = await VariantAttribute.findById(req.params.id);

    if (!variantAttribute) {
        return res.status(404).json({
            success: false,
            message: 'Variant attribute not found'
        });
    }

    res.status(200).json({
        success: true,
        data: variantAttribute
    });
});

// @desc    Get single variant attribute by slug
// @route   GET /api/variant-attributes/slug/:slug
// @access  Private
exports.getVariantAttributeBySlug = asyncHandler(async (req, res) => {
    const variantAttribute = await VariantAttribute.findOne({ slug: req.params.slug });

    if (!variantAttribute) {
        return res.status(404).json({
            success: false,
            message: 'Variant attribute not found'
        });
    }

    res.status(200).json({
        success: true,
        data: variantAttribute
    });
});

// Helper function to generate slug
const generateSlug = (name) => {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/(^_|_$)/g, '');
};

// Helper function to process models (for brands)
const processModels = (models) => {
    if (!models || !Array.isArray(models)) return [];
    return models.map(model => {
        if (typeof model === 'string') {
            return { name: model, slug: generateSlug(model), isActive: true };
        } else if (typeof model === 'object' && model.name) {
            return {
                ...model,
                slug: model.slug || generateSlug(model.name),
                isActive: model.isActive !== false
            };
        }
        return model;
    });
};

// Helper function to process values (convert strings to objects with slug)
const processValues = (values) => {
    if (!values || !Array.isArray(values)) return [];
    return values.map(val => {
        if (typeof val === 'string') {
            return { name: val, slug: generateSlug(val), isActive: true };
        } else if (typeof val === 'object' && val.name) {
            const processed = {
                ...val,
                slug: val.slug || generateSlug(val.name),
                isActive: val.isActive !== false
            };
            // Process models if present
            if (val.models) {
                processed.models = processModels(val.models);
            }
            return processed;
        }
        return val;
    });
};

// Ensure no duplicate name or slug within values array (case-insensitive). Returns { valid: boolean, message?: string }.
const validateNoDuplicateValues = (values) => {
    if (!values || values.length === 0) return { valid: true };
    const byName = new Map();
    const bySlug = new Map();
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const name = (v.name || '').trim();
        const slug = (v.slug || generateSlug(name)).toLowerCase();
        const nameLower = name.toLowerCase();
        const id = (v._id && v._id.toString()) ? v._id.toString() : `idx-${i}`;
        if (nameLower) {
            const existing = byName.get(nameLower);
            if (existing !== undefined && existing !== id) {
                return { valid: false, message: `Duplicate value: "${v.name}" already exists.` };
            }
            byName.set(nameLower, id);
        }
        if (slug) {
            const existing = bySlug.get(slug);
            if (existing !== undefined && existing !== id) {
                return { valid: false, message: `Duplicate value: a value with this name/slug already exists.` };
            }
            bySlug.set(slug, id);
        }
    }
    return { valid: true };
};

// Ensure no duplicate name or slug within models array (case-insensitive).
const validateNoDuplicateModels = (models) => {
    if (!models || models.length === 0) return { valid: true };
    const byName = new Map();
    const bySlug = new Map();
    for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const name = (m.name || '').trim();
        const slug = (m.slug || generateSlug(name)).toLowerCase();
        const nameLower = name.toLowerCase();
        const id = (m._id && m._id.toString()) ? m._id.toString() : `idx-${i}`;
        if (nameLower) {
            const existing = byName.get(nameLower);
            if (existing !== undefined && existing !== id) {
                return { valid: false, message: `Duplicate model: "${m.name}" already exists.` };
            }
            byName.set(nameLower, id);
        }
        if (slug) {
            const existing = bySlug.get(slug);
            if (existing !== undefined && existing !== id) {
                return { valid: false, message: `Duplicate model: a model with this name/slug already exists.` };
            }
            bySlug.set(slug, id);
        }
    }
    return { valid: true };
};

// @desc    Create variant attribute
// @route   POST /api/variant-attributes
// @access  Private/Admin/Manager
exports.createVariantAttribute = asyncHandler(async (req, res) => {
    // Check if name already exists
    const existingName = await VariantAttribute.findOne({ name: req.body.name });
    if (existingName) {
        return res.status(400).json({
            success: false,
            message: 'Variant attribute name already exists'
        });
    }

    // Process values to ensure they have slugs and reject duplicates
    if (req.body.values) {
        req.body.values = processValues(req.body.values);
        const valueCheck = validateNoDuplicateValues(req.body.values);
        if (!valueCheck.valid) {
            return res.status(400).json({
                success: false,
                message: valueCheck.message || 'Duplicate value names or slugs are not allowed.'
            });
        }
        for (const val of req.body.values) {
            if (val.models && val.models.length > 0) {
                const modelCheck = validateNoDuplicateModels(val.models);
                if (!modelCheck.valid) {
                    return res.status(400).json({
                        success: false,
                        message: modelCheck.message || 'Duplicate model names or slugs are not allowed.'
                    });
                }
            }
        }
    }

    // Generate slug from name
    req.body.slug = generateSlug(req.body.name);

    const variantAttribute = await VariantAttribute.create(req.body);
    _invalidateVariantListCache();
    await cache.bumpNs('variantAttributes:list', getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Variant attribute created successfully',
        data: variantAttribute
    });
});

// @desc    Update variant attribute
// @route   PUT /api/variant-attributes/:id
// @access  Private/Admin/Manager
exports.updateVariantAttribute = asyncHandler(async (req, res) => {
    let variantAttribute = await VariantAttribute.findById(req.params.id);

    if (!variantAttribute) {
        return res.status(404).json({
            success: false,
            message: 'Variant attribute not found'
        });
    }

    // If name is being updated, check for duplicates and update slug
    if (req.body.name && req.body.name !== variantAttribute.name) {
        const existingName = await VariantAttribute.findOne({
            name: req.body.name,
            _id: { $ne: req.params.id }
        });
        if (existingName) {
            return res.status(400).json({
                success: false,
                message: 'Variant attribute name already exists'
            });
        }
        // Regenerate slug when name changes
        req.body.slug = generateSlug(req.body.name);
    }

    // Process values to ensure they have slugs and reject duplicates
    if (req.body.values) {
        req.body.values = processValues(req.body.values);
        const valueCheck = validateNoDuplicateValues(req.body.values);
        if (!valueCheck.valid) {
            return res.status(400).json({
                success: false,
                message: valueCheck.message || 'Duplicate value names or slugs are not allowed.'
            });
        }
        for (const val of req.body.values) {
            if (val.models && val.models.length > 0) {
                const modelCheck = validateNoDuplicateModels(val.models);
                if (!modelCheck.valid) {
                    return res.status(400).json({
                        success: false,
                        message: modelCheck.message || 'Duplicate model names or slugs are not allowed.'
                    });
                }
            }
        }
    }

    variantAttribute = await VariantAttribute.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    _invalidateVariantListCache();
    await cache.bumpNs('variantAttributes:list', getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Variant attribute updated successfully',
        data: variantAttribute
    });
});

// @desc    Delete variant attribute
// @route   DELETE /api/variant-attributes/:id
// @access  Private/Admin
exports.deleteVariantAttribute = asyncHandler(async (req, res) => {
    const variantAttribute = await VariantAttribute.findById(req.params.id);

    if (!variantAttribute) {
        return res.status(404).json({
            success: false,
            message: 'Variant attribute not found'
        });
    }

    await variantAttribute.deleteOne();
    _invalidateVariantListCache();
    await cache.bumpNs('variantAttributes:list', getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Variant attribute deleted successfully'
    });
});

// @desc    Get active variant attributes (for dropdown)
// @route   GET /api/variant-attributes/active
// @access  Private
exports.getActiveVariantAttributes = asyncHandler(async (req, res) => {
    const variantAttributes = await VariantAttribute.find({ isActive: true }).sort('name');

    res.status(200).json({
        success: true,
        count: variantAttributes.length,
        data: variantAttributes
    });
});

// @desc    Add a new value (e.g. new brand) to a variant attribute
// @route   POST /api/variant-attributes/:id/values
// @access  Private
exports.addVariantAttributeValue = asyncHandler(async (req, res) => {
    const attr = await VariantAttribute.findById(req.params.id);
    if (!attr) {
        return res.status(404).json({ success: false, message: 'Variant attribute not found' });
    }
    // Preserve exact casing as typed by user (no toUpperCase)
    const name = String(req.body.name || '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const slug = generateSlug(name);
    const existing = (attr.values || []).find(v => (v.slug || '').toLowerCase() === slug.toLowerCase());
    if (existing) {
        const data = { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false, models: existing.models || [] };
        return res.status(200).json({ success: true, data, message: 'Value already exists' });
    }
    const newValue = { _id: new mongoose.Types.ObjectId(), name, slug, isActive: true };
    if (attr.slug === 'brands' || (attr.values && attr.values[0] && Array.isArray(attr.values[0].models))) {
        newValue.models = [];
    }
    // Use atomic $push so the update persists reliably
    const updated = await VariantAttribute.findByIdAndUpdate(
        req.params.id,
        { $push: { values: newValue } },
        { new: true, runValidators: true }
    );
    if (!updated || !updated.values || updated.values.length === 0) {
        return res.status(500).json({ success: false, message: 'Failed to add value' });
    }
    const created = updated.values[updated.values.length - 1];
    const data = { _id: created._id, name: created.name, slug: created.slug, isActive: created.isActive !== false, models: created.models || [] };
    res.status(201).json({ success: true, data });
});

// @desc    Check if a variant value is in use (purchase/parcel items)
// @route   GET /api/variant-attributes/check-value-usage?attributeSlug=storage&value=125
// @access  Private
exports.checkVariantValueUsage = asyncHandler(async (req, res) => {
    const attributeSlug = (req.query.attributeSlug || '').trim();
    const value = (req.query.value || '').trim();
    if (!attributeSlug || !value) {
        return res.status(400).json({ success: false, message: 'attributeSlug and value are required' });
    }
    const { inUse, count } = await checkVariantValueInUse(attributeSlug, value);
    res.status(200).json({ success: true, inUse, count });
});

// @desc    Replace a variant value in purchases then remove it from the attribute
// @route   POST /api/variant-attributes/:id/values/replace-and-remove
// @body    { valueNameToRemove: string, replacementValueName?: string }
// @access  Private
exports.replaceAndRemoveVariantValue = asyncHandler(async (req, res) => {
    const attr = await VariantAttribute.findById(req.params.id);
    if (!attr) {
        return res.status(404).json({ success: false, message: 'Variant attribute not found' });
    }
    const valueNameToRemove = (req.body.valueNameToRemove || '').trim();
    const replacementValueName = req.body.replacementValueName != null ? String(req.body.replacementValueName).trim() : '';
    if (!valueNameToRemove) {
        return res.status(400).json({ success: false, message: 'valueNameToRemove is required' });
    }
    const values = attr.values || [];
    const toRemove = values.find(v => (v.name || '').trim().toLowerCase() === valueNameToRemove.toLowerCase());
    if (!toRemove) {
        return res.status(404).json({ success: false, message: 'Value to remove not found in this attribute' });
    }
    const slug = (attr.slug || '').trim();
    if (!slug) {
        return res.status(400).json({ success: false, message: 'Attribute has no slug' });
    }
    const { inUse, count } = await checkVariantValueInUse(slug, valueNameToRemove);
    if (inUse) {
        if (!replacementValueName) {
            const others = values
                .filter(v => (v.name || '').trim().toLowerCase() !== valueNameToRemove.toLowerCase())
                .map(v => ({ _id: v._id, name: v.name, slug: v.slug }));
            return res.status(400).json({
                success: false,
                inUse: true,
                count,
                message: `This value is in use in ${count} purchase item(s). Provide a replacement value from the same attribute.`,
                replacementOptions: others
            });
        }
        const replacementExists = values.some(v => (v.name || '').trim().toLowerCase() === replacementValueName.toLowerCase());
        if (!replacementExists) {
            return res.status(400).json({ success: false, message: 'Replacement value must be an existing value of the same attribute' });
        }
        await replaceVariantValueInPurchases(slug, valueNameToRemove, replacementValueName);
    }
    const newValues = values.filter(v => (v.name || '').trim().toLowerCase() !== valueNameToRemove.toLowerCase());
    attr.values = newValues;
    attr.markModified('values');
    await attr.save();
    res.status(200).json({ success: true, data: attr, message: inUse ? 'Replaced in purchases and removed value' : 'Value removed' });
});

// @desc    Add a new model under a value (e.g. new model under a brand)
// @route   POST /api/variant-attributes/:id/values/:valueId/models
// @access  Private
exports.addVariantAttributeValueModel = asyncHandler(async (req, res) => {
    const attr = await VariantAttribute.findById(req.params.id);
    if (!attr) {
        return res.status(404).json({ success: false, message: 'Variant attribute not found' });
    }
    const value = attr.values.id(req.params.valueId);
    if (!value) {
        return res.status(404).json({ success: false, message: 'Value (brand) not found' });
    }
    // Preserve exact casing as typed by user (no toUpperCase)
    const name = String(req.body.name || '').trim();
    if (!name) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const slug = generateSlug(name);
    const models = value.models || [];
    const existing = models.find(m => (m.slug || '').toLowerCase() === slug.toLowerCase());
    if (existing) {
        const data = { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false };
        return res.status(200).json({ success: true, data, message: 'Model already exists' });
    }
    const newModel = { _id: new mongoose.Types.ObjectId(), name, slug, isActive: true };
    // Use atomic $push with positional $ so the update persists reliably
    const updated = await VariantAttribute.findOneAndUpdate(
        { _id: req.params.id, 'values._id': req.params.valueId },
        { $push: { 'values.$.models': newModel } },
        { new: true, runValidators: true }
    );
    if (!updated) {
        return res.status(500).json({ success: false, message: 'Failed to add model' });
    }
    const updatedValue = updated.values.id(req.params.valueId);
    const created = updatedValue && updatedValue.models && updatedValue.models.length > 0
        ? updatedValue.models[updatedValue.models.length - 1]
        : newModel;
    const data = { _id: created._id, name: created.name, slug: created.slug, isActive: created.isActive !== false };
    res.status(201).json({ success: true, data });
});
