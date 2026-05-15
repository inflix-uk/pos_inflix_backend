const mongoose = require('mongoose');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const Product = require('../models/Product');
const VariantAttribute = require('../models/VariantAttribute');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { makeSwrCache } = require('../utils/swrCache');
const { checkVariantValueInUse, replaceVariantValueInPurchases } = require('../utils/variantValueUsage');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

// SWR cache for /api/categories. Key includes filter params so each (tenant, filter combo) is cached independently.
// Slim path (used by create-sales for the full category list) gets longer freshness because the result is bigger
// and changes only on category CRUD — both cache slices share invalidate().
const _categoryListCache = makeSwrCache({ freshMs: 30_000, maxStaleMs: 5 * 60_000 });

function _categoryCacheKey(tenantId, query, opts) {
    return [
        tenantId || '_',
        opts.slim ? 'slim' : 'full',
        opts.page, opts.limit,
        query.isActive == null ? '_' : (query.isActive ? '1' : '0'),
        opts.search || '_',
        opts.itemType || '_'
    ].join('|');
}

/** Bust on category create/update/delete (and on variantAttribute changes, since populated fields embed). */
function _invalidateCategoryListCache() { _categoryListCache.invalidate(null); }
exports._invalidateCategoryListCache = _invalidateCategoryListCache;

const generateSlug = (name) => {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/(^_|_$)/g, '');
};

// Map model for API response (include children recursively)
const mapModel = (m) => {
    if (!m || m.isActive === false) return null;
    const children = (m.children || []).filter(Boolean).map(mapModel).filter(Boolean);
    return {
        _id: m._id,
        name: m.name,
        slug: m.slug,
        models: undefined,
        children: children.length ? children : undefined
    };
};

// @desc    Get all categories
// @route   GET /api/categories
// @access  Private
exports.getCategories = asyncHandler(async (req, res) => {
    const _t0 = Date.now();
    // Ensure VariantAttribute model is registered on the tenant connection for populate
    void VariantAttribute.modelName;

    const query = {};

    if (req.query.isActive !== undefined) {
        query.isActive = req.query.isActive === 'true';
    }

    if (req.query.search) {
        query.name = { $regex: req.query.search, $options: 'i' };
    }

    if (req.query.itemType === 'serial') {
        query.$or = [{ itemType: 'serial' }, { itemType: 'both' }, { itemType: { $exists: false } }];
    } else if (req.query.itemType === 'non-serial') {
        query.$or = [{ itemType: 'non-serial' }, { itemType: 'both' }, { itemType: { $exists: false } }];
    }

    // slim=1: return only fields needed by create-sales (name, icon, variantAttributes slugs).
    // Excludes the massive variantAttributeValues tree and skips subcategory count query.
    const slim = req.query.slim === '1';
    // Pagination: only applied when frontend explicitly asks for it. Slim consumers and
    // legacy callers without page/limit get the full list (backwards-compat).
    const requestedPage = parseInt(req.query.page, 10);
    const requestedLimit = parseInt(req.query.limit, 10);
    const paginate = !slim && Number.isFinite(requestedPage) && Number.isFinite(requestedLimit);
    const page = paginate ? Math.max(1, requestedPage) : 1;
    const limit = paginate ? Math.min(500, Math.max(1, requestedLimit)) : 0;

    const tenantId = getTenantIdFromReq(req);
    const cacheKey = _categoryCacheKey(tenantId, query, {
        slim, page, limit,
        search: req.query.search,
        itemType: req.query.itemType
    });

    // Redis-backed list cache for multi-instance sharing. Lives BELOW the in-memory SWR layer
    // so single-instance hits stay process-local; multi-instance deployments still share via Redis.
    const redisParams = {
        slim, page, limit,
        isActive: req.query.isActive == null ? null : (req.query.isActive === 'true'),
        search: req.query.search || null,
        itemType: req.query.itemType || null,
    };

    const dbFetcher = async () => {
        if (slim) {
            // Lightweight all-rows shape used by create-sales — no subcategory counts, no pagination.
            const rows = await Category.find(query)
                .sort('name')
                .select('_id name icon variantAttributes')
                .populate('variantAttributes', 'name slug')
                .lean();
            return { data: rows, total: rows.length, paginate: false };
        }

        if (paginate) {
            // Single-roundtrip pagination: $facet returns total + the page slice + subcategory counts in one query.
            const [{ total: totalArr, data }] = await Category.aggregate([
                { $match: query },
                { $sort: { name: 1 } },
                {
                    $facet: {
                        total: [{ $count: 'n' }],
                        data: [
                            { $skip: (page - 1) * limit },
                            { $limit: limit },
                            {
                                $lookup: {
                                    from: VariantAttribute.collection.name,
                                    let: { vaIds: { $ifNull: ['$variantAttributes', []] } },
                                    pipeline: [
                                        { $match: { $expr: { $in: ['$_id', '$$vaIds'] } } },
                                        { $project: { name: 1, slug: 1 } }
                                    ],
                                    as: 'variantAttributes'
                                }
                            },
                            {
                                $lookup: {
                                    from: SubCategory.collection.name,
                                    let: { catId: '$_id' },
                                    pipeline: [
                                        { $match: { $expr: { $eq: ['$category', '$$catId'] } } },
                                        { $count: 'n' }
                                    ],
                                    as: '_subs'
                                }
                            },
                            {
                                $addFields: {
                                    subCategoryCount: { $ifNull: [{ $arrayElemAt: ['$_subs.n', 0] }, 0] }
                                }
                            },
                            { $project: { _subs: 0 } }
                        ]
                    }
                }
            ]);
            const total = (totalArr && totalArr[0] && totalArr[0].n) || 0;
            return { data, total, paginate: true };
        }

        // Legacy non-paginated full path: keep current behavior so old callers don't break.
        const categories = await Category.find(query).sort('name').populate('variantAttributes', 'name slug').lean();
        const categoryIds = categories.map((c) => c._id);
        const subCounts = categoryIds.length > 0
            ? await SubCategory.aggregate([
                { $match: { category: { $in: categoryIds } } },
                { $group: { _id: '$category', count: { $sum: 1 } } }
            ])
            : [];
        const countMap = {};
        subCounts.forEach((r) => { countMap[String(r._id)] = r.count; });
        const responseData = categories.map((c) => ({ ...c, subCategoryCount: countMap[String(c._id)] || 0 }));
        return { data: responseData, total: categories.length, paginate: false };
    };

    // Multi-instance share: Redis sits between dbFetcher and the in-memory SWR cache.
    const fetcher = async () => cache.cached(
        { ns: 'categories:list', tenantId, params: redisParams, ttlSec: TTL.CATALOG },
        dbFetcher
    );

    const cachedEntry = _categoryListCache.get(cacheKey);
    let result;
    if (cachedEntry) {
        result = cachedEntry.value;
        if (cachedEntry.isStale) _categoryListCache.revalidate(cacheKey, fetcher);
    } else {
        result = await _categoryListCache.fetch(cacheKey, fetcher);
    }

    res.setHeader('X-Controller-Timing', `${Date.now() - _t0}ms`);
    const body = {
        success: true,
        count: result.data.length,
        data: result.data
    };
    if (result.paginate) {
        body.total = result.total;
        body.page = page;
        body.pages = Math.max(1, Math.ceil(result.total / limit));
    }
    res.status(200).json(body);
});

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Private
exports.getCategory = asyncHandler(async (req, res) => {
    // Ensure VariantAttribute model is registered on the tenant connection so
    // populate resolves against the correct database (not the default one).
    void VariantAttribute.modelName;

    const category = await Category.findById(req.params.id)
        .populate('variantAttributes', 'name slug values isActive');

    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    res.status(200).json({
        success: true,
        data: category
    });
});

// @desc    Get variant attributes assigned to a category (for purchase form etc.)
// @route   GET /api/categories/:id/variant-attributes
// @access  Private
// Returns each attribute with values stored against this category (brands for Phones vs Laptops etc.)
// Order of response = display order set in Edit Category (variantAttributes array order).
exports.getCategoryVariantAttributes = asyncHandler(async (req, res) => {
    // Ensure VariantAttribute model is registered on the tenant connection for populate
    void VariantAttribute.modelName;

    const category = await Category.findById(req.params.id)
        .populate('variantAttributes', 'name slug');

    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    // Preserve exact display order from category (Edit Category "Display order (top to bottom)")
    const attrs = Array.isArray(category.variantAttributes) ? [...category.variantAttributes] : [];
    const categoryValues = category.variantAttributeValues || [];

    // First attribute holds the full tree (values → models → children → …). Others get empty values; frontend derives options from tree.
    const firstAttrId = attrs.length > 0 ? attrs[0]._id.toString() : null;
    const treeEntry = firstAttrId ? categoryValues.find(
        (v) => v.attribute && v.attribute.toString() === firstAttrId
    ) : null;

    const data = attrs.map((attr, index) => {
        const isFirst = index === 0 && firstAttrId && attr._id.toString() === firstAttrId;
        const entry = isFirst ? treeEntry : categoryValues.find(
            (v) => v.attribute && v.attribute.toString() === attr._id.toString()
        );
        // Only first attribute gets the full tree; rest get empty values (frontend derives from tree by parent path)
        const values = isFirst && entry && entry.values
            ? entry.values
                  .filter((v) => v.isActive !== false)
                  .map((v) => {
                      const models = (v.models || []).filter((m) => m.isActive !== false).map((m) => ({
                          _id: m._id,
                          name: m.name,
                          slug: m.slug,
                          children: (m.children || []).filter((c) => c && c.isActive !== false).map(mapModel).filter(Boolean)
                      }));
                      return {
                          _id: v._id,
                          name: v.name,
                          slug: v.slug,
                          models
                      };
                  })
            : [];
        return {
            _id: attr._id,
            name: attr.name,
            slug: attr.slug,
            values
        };
    });

    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Add a variant value to a category (e.g. add brand "Apple" for Phones category)
// @route   POST /api/categories/:id/variant-attributes/:attributeId/values
// @access  Private
exports.addCategoryVariantValue = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const isAssigned = (category.variantAttributes || []).some(
        (id) => id && id.toString() === attributeId
    );
    if (!isAssigned) {
        return res.status(400).json({ success: false, message: 'Attribute is not assigned to this category' });
    }
    const rawName = String(req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const name = rawName.toUpperCase();
    const slug = generateSlug(name);
    const variantAttributeValues = category.variantAttributeValues || [];
    let entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (entry) {
        const existing = (entry.values || []).find(
            (v) => (v.slug || '').toLowerCase() === slug.toLowerCase()
        );
        if (existing) {
            const data = {
                _id: existing._id,
                name: existing.name,
                slug: existing.slug,
                isActive: existing.isActive !== false,
                models: existing.models || []
            };
            return res.status(200).json({ success: true, data, message: 'Value already exists' });
        }
    }
    const newValue = {
        _id: new mongoose.Types.ObjectId(),
        name,
        slug,
        isActive: true,
        models: []
    };
    if (!entry) {
        variantAttributeValues.push({
            attribute: new mongoose.Types.ObjectId(attributeId),
            values: [newValue]
        });
        category.variantAttributeValues = variantAttributeValues;
    } else {
        entry.values = entry.values || [];
        entry.values.push(newValue);
    }
    category.markModified('variantAttributeValues');
    await category.save();
    const data = {
        _id: newValue._id,
        name: newValue.name,
        slug: newValue.slug,
        isActive: newValue.isActive,
        models: newValue.models || []
    };
    res.status(201).json({ success: true, data });
});

// @desc    Add a model under a variant value (e.g. add model "iPhone 15" under brand "Apple")
// @route   POST /api/categories/:id/variant-attributes/:attributeId/values/:valueId/models
// @access  Private
exports.addCategoryVariantValueModel = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const valueId = req.params.valueId;
    const variantAttributeValues = category.variantAttributeValues || [];
    const entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (!entry || !entry.values) {
        return res.status(404).json({ success: false, message: 'Value (e.g. brand) not found for this category' });
    }
    const value = entry.values.id(valueId);
    if (!value) {
        return res.status(404).json({ success: false, message: 'Value not found' });
    }
    const rawName = String(req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const name = rawName.toUpperCase();
    const slug = generateSlug(name);
    const models = value.models || [];
    const existing = models.find((m) => (m.slug || '').toLowerCase() === slug.toLowerCase());
    if (existing) {
        const data = { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false };
        return res.status(200).json({ success: true, data, message: 'Model already exists' });
    }
    const newModel = {
        _id: new mongoose.Types.ObjectId(),
        name,
        slug,
        isActive: true
    };
    value.models = value.models || [];
    value.models.push(newModel);
    category.markModified('variantAttributeValues');
    await category.save();
    const data = { _id: newModel._id, name: newModel.name, slug: newModel.slug, isActive: newModel.isActive };
    res.status(201).json({ success: true, data });
});

// @desc    Add a child under a model (e.g. add condition "Grade A" under model "iPhone 15")
// @route   POST /api/categories/:id/variant-attributes/:attributeId/values/:valueId/models/:modelId/children
// @access  Private
exports.addCategoryVariantValueModelChild = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const valueId = req.params.valueId;
    const modelId = req.params.modelId;
    const variantAttributeValues = category.variantAttributeValues || [];
    const entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (!entry || !entry.values) {
        return res.status(404).json({ success: false, message: 'Variant values not found for this category' });
    }
    const value = entry.values.id(valueId);
    if (!value) {
        return res.status(404).json({ success: false, message: 'Value (e.g. brand) not found' });
    }
    const model = (value.models || []).find((m) => m._id && m._id.toString() === modelId);
    if (!model) {
        return res.status(404).json({ success: false, message: 'Model not found' });
    }
    const rawName = String(req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const name = rawName.toUpperCase();
    const slug = generateSlug(name);
    const children = model.children || [];
    const existing = children.find((c) => c && (c.slug || '').toLowerCase() === slug.toLowerCase());
    if (existing) {
        const data = { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false };
        return res.status(200).json({ success: true, data, message: 'Child value already exists' });
    }
    const newChild = {
        _id: new mongoose.Types.ObjectId(),
        name,
        slug,
        isActive: true,
        children: []
    };
    if (!model.children) {
        model.children = [];
    }
    model.children.push(newChild);
    category.markModified('variantAttributeValues');
    await category.save();
    const data = { _id: newChild._id, name: newChild.name, slug: newChild.slug, isActive: newChild.isActive };
    res.status(201).json({ success: true, data });
});

// @desc    Add a variant value at any level (fully dynamic: works for any number of attributes per category)
// @route   POST /api/categories/:id/variant-attributes/:attributeId/values/add-at-path
// @body    { parentPath: string[] (ids from root to parent; [] = root), name: string }
// @access  Private
exports.addCategoryVariantValueAtPath = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const isAssigned = (category.variantAttributes || []).some(
        (id) => id && id.toString() === attributeId
    );
    if (!isAssigned) {
        return res.status(400).json({ success: false, message: 'Attribute is not assigned to this category' });
    }
    const parentPath = Array.isArray(req.body.parentPath) ? req.body.parentPath.map(String) : [];
    const rawName = String(req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const name = rawName.toUpperCase();
    const slug = generateSlug(name);
    let variantAttributeValues = category.variantAttributeValues || [];
    let entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (!entry) {
        entry = {
            attribute: new mongoose.Types.ObjectId(attributeId),
            values: []
        };
        variantAttributeValues.push(entry);
        category.variantAttributeValues = variantAttributeValues;
    }
    entry.values = entry.values || [];

    if (parentPath.length === 0) {
        const existing = entry.values.find((v) => (v.slug || '').toLowerCase() === slug.toLowerCase());
        if (existing) {
            return res.status(200).json({
                success: true,
                data: { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false, models: existing.models || [] },
                message: 'Value already exists'
            });
        }
        const newValue = {
            _id: new mongoose.Types.ObjectId(),
            name,
            slug,
            isActive: true,
            models: []
        };
        entry.values.push(newValue);
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(201).json({
            success: true,
            data: { _id: newValue._id, name: newValue.name, slug: newValue.slug, isActive: newValue.isActive, models: [] }
        });
    }

    if (parentPath.length === 1) {
        const value = entry.values.id(parentPath[0]);
        if (!value) {
            return res.status(404).json({ success: false, message: 'Parent value not found' });
        }
        value.models = value.models || [];
        const existing = value.models.find((m) => (m.slug || '').toLowerCase() === slug.toLowerCase());
        if (existing) {
            return res.status(200).json({
                success: true,
                data: { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false },
                message: 'Value already exists'
            });
        }
        const newModel = {
            _id: new mongoose.Types.ObjectId(),
            name,
            slug,
            isActive: true,
            children: []
        };
        value.models.push(newModel);
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(201).json({
            success: true,
            data: { _id: newModel._id, name: newModel.name, slug: newModel.slug, isActive: newModel.isActive }
        });
    }

    const value = entry.values.id(parentPath[0]);
    if (!value) {
        return res.status(404).json({ success: false, message: 'Parent value not found' });
    }
    let node = (value.models || []).find((m) => m._id && m._id.toString() === parentPath[1]);
    if (!node) {
        return res.status(404).json({ success: false, message: 'Parent node not found at path' });
    }
    for (let i = 2; i < parentPath.length; i++) {
        const next = (node.children || []).find((c) => c && c._id && c._id.toString() === parentPath[i]);
        if (!next) {
            return res.status(404).json({ success: false, message: 'Parent node not found at path' });
        }
        node = next;
    }
    node.children = node.children || [];
    const existing = node.children.find((c) => c && (c.slug || '').toLowerCase() === slug.toLowerCase());
    if (existing) {
        return res.status(200).json({
            success: true,
            data: { _id: existing._id, name: existing.name, slug: existing.slug, isActive: existing.isActive !== false },
            message: 'Value already exists'
        });
    }
    const newChild = {
        _id: new mongoose.Types.ObjectId(),
        name,
        slug,
        isActive: true,
        children: []
    };
    node.children.push(newChild);
    category.markModified('variantAttributeValues');
    await category.save();
    return     res.status(201).json({
        success: true,
        data: { _id: newChild._id, name: newChild.name, slug: newChild.slug, isActive: newChild.isActive }
    });
});

// @desc    Update a variant value at path (rename)
// @route   PUT /api/categories/:id/variant-attributes/:attributeId/values/update-at-path
// @body    { path: string[] (full path to node including its id), name: string }
// @access  Private
exports.updateCategoryVariantValueAtPath = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const path = Array.isArray(req.body.path) ? req.body.path.map(String) : [];
    const rawName = String(req.body.name || '').trim();
    if (!rawName) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (path.length === 0) {
        return res.status(400).json({ success: false, message: 'Path is required' });
    }
    const name = rawName.toUpperCase();
    const slug = generateSlug(name);
    const variantAttributeValues = category.variantAttributeValues || [];
    const entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (!entry || !entry.values) {
        return res.status(404).json({ success: false, message: 'Variant values not found' });
    }
    const nodeId = path[path.length - 1];
    const slugLower = slug.toLowerCase();

    if (path.length === 1) {
        const value = entry.values.id(nodeId);
        if (!value) {
            return res.status(404).json({ success: false, message: 'Value not found' });
        }
        const duplicate = entry.values.some(
            (v) => v._id && v._id.toString() !== nodeId && (
                (v.name || '').toUpperCase() === name ||
                (v.slug || '').toLowerCase() === slugLower
            )
        );
        if (duplicate) {
            return res.status(400).json({
                success: false,
                message: 'A value with this name already exists. Choose a different name.'
            });
        }
        value.name = name;
        value.slug = slug;
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(200).json({
            success: true,
            data: { _id: value._id, name: value.name, slug: value.slug, isActive: value.isActive !== false, models: value.models || [] }
        });
    }
    if (path.length === 2) {
        const value = entry.values.id(path[0]);
        if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
        const model = (value.models || []).find((m) => m._id && m._id.toString() === nodeId);
        if (!model) return res.status(404).json({ success: false, message: 'Node not found' });
        const siblings = value.models || [];
        const duplicate = siblings.some(
            (m) => m._id && m._id.toString() !== nodeId && (
                (m.name || '').toUpperCase() === name ||
                (m.slug || '').toLowerCase() === slugLower
            )
        );
        if (duplicate) {
            return res.status(400).json({
                success: false,
                message: 'A model with this name already exists. Choose a different name.'
            });
        }
        model.name = name;
        model.slug = slug;
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(200).json({
            success: true,
            data: { _id: model._id, name: model.name, slug: model.slug, isActive: model.isActive !== false }
        });
    }
    const value = entry.values.id(path[0]);
    if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
    let node = (value.models || []).find((m) => m._id && m._id.toString() === path[1]);
    if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
    for (let i = 2; i < path.length - 1; i++) {
        node = (node.children || []).find((c) => c && c._id && c._id.toString() === path[i]);
        if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
    }
    const child = (node.children || []).find((c) => c && c._id && c._id.toString() === nodeId);
    if (!child) return res.status(404).json({ success: false, message: 'Node not found' });
    const siblings = node.children || [];
    const duplicate = siblings.some(
        (c) => c && c._id && c._id.toString() !== nodeId && (
            (c.name || '').toUpperCase() === name ||
            (c.slug || '').toLowerCase() === slugLower
        )
    );
    if (duplicate) {
        return res.status(400).json({
            success: false,
            message: 'A value with this name already exists. Choose a different name.'
        });
    }
    child.name = name;
    child.slug = slug;
    category.markModified('variantAttributeValues');
    await category.save();
    return res.status(200).json({
        success: true,
        data: { _id: child._id, name: child.name, slug: child.slug, isActive: child.isActive !== false }
    });
});

// @desc    Delete a variant value at path (remove from category)
// @route   DELETE /api/categories/:id/variant-attributes/:attributeId/values/delete-at-path
// @body    { path: string[] (full path to node including its id), replacementValueName?: string }
// @access  Private
exports.deleteCategoryVariantValueAtPath = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const attributeId = req.params.attributeId;
    const path = Array.isArray(req.body.path) ? req.body.path.map(String) : [];
    if (path.length === 0) {
        return res.status(400).json({ success: false, message: 'Path is required' });
    }
    const variantAttributeValues = category.variantAttributeValues || [];
    const entry = variantAttributeValues.find(
        (v) => v.attribute && v.attribute.toString() === attributeId
    );
    if (!entry || !entry.values) {
        return res.status(404).json({ success: false, message: 'Variant values not found' });
    }
    const nodeId = path[path.length - 1];
    let valueNameToDelete = null;
    let siblingValues = [];

    if (path.length === 1) {
        const idx = entry.values.findIndex((v) => v._id && v._id.toString() === nodeId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Value not found' });
        valueNameToDelete = (entry.values[idx].name || '').trim();
        siblingValues = entry.values
            .filter((v, i) => i !== idx)
            .map((v) => ({ _id: v._id, name: v.name, slug: v.slug }));
    } else if (path.length === 2) {
        const value = entry.values.id(path[0]);
        if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
        value.models = value.models || [];
        const idx = value.models.findIndex((m) => m._id && m._id.toString() === nodeId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Node not found' });
        valueNameToDelete = (value.models[idx].name || '').trim();
        siblingValues = value.models
            .filter((m, i) => i !== idx)
            .map((m) => ({ _id: m._id, name: m.name, slug: m.slug }));
    } else {
        const value = entry.values.id(path[0]);
        if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
        let node = (value.models || []).find((m) => m._id && m._id.toString() === path[1]);
        if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
        for (let i = 2; i < path.length - 1; i++) {
            node = (node.children || []).find((c) => c && c._id && c._id.toString() === path[i]);
            if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
        }
        const children = node.children || [];
        const idx = children.findIndex((c) => c && c._id && c._id.toString() === nodeId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Node not found' });
        valueNameToDelete = (children[idx].name || '').trim();
        siblingValues = children.filter((c, i) => i !== idx).map((c) => ({ _id: c._id, name: c.name, slug: c.slug }));
    }

    const attr = await VariantAttribute.findById(attributeId).select('slug name').lean();
    let slug = attr && (attr.slug || '').trim();
    if (!slug && attr && attr.name) {
        slug = (attr.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
    }
    if (valueNameToDelete) {
        const { inUse, count } = await checkVariantValueInUse(slug, valueNameToDelete);
        if (inUse) {
            const replacementValueName = req.body.replacementValueName != null ? String(req.body.replacementValueName).trim() : '';
            if (!replacementValueName) {
                return res.status(400).json({
                    success: false,
                    inUse: true,
                    count,
                    message: `This value is in use in ${count} purchase item(s). Provide a replacement value from the same attribute.`,
                    replacementOptions: siblingValues
                });
            }
            const replacementExists = siblingValues.some(
                (s) => (s.name || '').trim().toLowerCase() === replacementValueName.toLowerCase()
            );
            if (!replacementExists) {
                return res.status(400).json({ success: false, message: 'Replacement value must be a sibling value of the same attribute' });
            }
            await replaceVariantValueInPurchases(slug, valueNameToDelete, replacementValueName);
        }
    }

    if (path.length === 1) {
        const idx = entry.values.findIndex((v) => v._id && v._id.toString() === nodeId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Value not found' });
        entry.values.splice(idx, 1);
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(200).json({ success: true, message: 'Deleted' });
    }
    if (path.length === 2) {
        const value = entry.values.id(path[0]);
        if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
        value.models = value.models || [];
        const idx = value.models.findIndex((m) => m._id && m._id.toString() === nodeId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Node not found' });
        value.models.splice(idx, 1);
        category.markModified('variantAttributeValues');
        await category.save();
        return res.status(200).json({ success: true, message: 'Deleted' });
    }
    const value = entry.values.id(path[0]);
    if (!value) return res.status(404).json({ success: false, message: 'Parent not found' });
    let node = (value.models || []).find((m) => m._id && m._id.toString() === path[1]);
    if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
    for (let i = 2; i < path.length - 1; i++) {
        node = (node.children || []).find((c) => c && c._id && c._id.toString() === path[i]);
        if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
    }
    node.children = node.children || [];
    const idx = node.children.findIndex((c) => c && c._id && c._id.toString() === nodeId);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Node not found' });
    node.children.splice(idx, 1);
    category.markModified('variantAttributeValues');
    await category.save();
    return res.status(200).json({ success: true, message: 'Deleted' });
});

// @desc    Get single category by slug
// @route   GET /api/categories/slug/:slug
// @access  Private
exports.getCategoryBySlug = asyncHandler(async (req, res) => {
    const category = await Category.findOne({ slug: req.params.slug });

    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    // Get subcategory count
    const subCategoryCount = await SubCategory.countDocuments({ category: category._id });

    res.status(200).json({
        success: true,
        data: {
            ...category.toObject(),
            subCategoryCount
        }
    });
});

// @desc    Create category
// @route   POST /api/categories
// @access  Private/Admin/Manager
exports.createCategory = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const category = await Category.create(req.body);
    _invalidateCategoryListCache();
    await cache.bumpMany(['categories:list', 'products:list'], tenantId);

    res.status(201).json({
        success: true,
        message: 'Category created successfully',
        data: category
    });
});

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private/Admin/Manager
// variantAttributes in body = display order (same order as Edit Category "Display order (top to bottom)").
exports.updateCategory = asyncHandler(async (req, res) => {
    let category = await Category.findById(req.params.id);

    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    const update = { ...req.body };
    // Preserve variantAttributes array order when provided (display order from Edit Category)
    if (Array.isArray(req.body.variantAttributes)) {
        update.variantAttributes = req.body.variantAttributes;
    }

    category = await Category.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true
    });
    _invalidateCategoryListCache();
    await cache.bumpMany(['categories:list', 'products:list'], getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Category updated successfully',
        data: category
    });
});

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private/Admin
exports.deleteCategory = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);

    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    // Check if category has products
    const productCount = await Product.countDocuments({ category: req.params.id });

    if (productCount > 0) {
        return res.status(400).json({
            success: false,
            message: `Cannot delete category. ${productCount} products are using this category`
        });
    }

    await category.deleteOne();
    _invalidateCategoryListCache();
    await cache.bumpMany(['categories:list', 'products:list'], getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Category deleted successfully'
    });
});
