const SubCategory = require('../models/SubCategory');
const Category = require('../models/Category');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

// @desc    Get all sub-categories
// @route   GET /api/subcategories
// @access  Private
exports.getSubCategories = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const params = {
        page, limit,
        isActive: req.query.isActive,
        category: req.query.category || null,
        search: req.query.search || null,
    };

    const payload = await cache.cached(
        { ns: 'subCategories:list', tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = {};

            if (req.query.isActive !== undefined) {
                query.isActive = req.query.isActive === 'true';
            }

            if (req.query.category) {
                query.category = req.query.category;
            }

            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { code: { $regex: req.query.search, $options: 'i' } },
                    { description: { $regex: req.query.search, $options: 'i' } }
                ];
            }

            const total = await SubCategory.countDocuments(query);
            const subCategories = await SubCategory.find(query)
                .populate('category', 'name')
                .sort('-createdAt')
                .skip(skip)
                .limit(limit)
                .lean();

            const transformedData = subCategories.map((sub) => ({
                _id: sub._id,
                name: sub.name,
                slug: sub.slug,
                category: (sub.category && sub.category.name) || '',
                categoryId: (sub.category && sub.category._id) || '',
                code: sub.code,
                description: sub.description,
                image: sub.image,
                isActive: sub.isActive,
                createdAt: sub.createdAt,
                updatedAt: sub.updatedAt
            }));

            return { total, data: transformedData };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.data.length,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit),
        data: payload.data
    });
});

// @desc    Get single sub-category
// @route   GET /api/subcategories/:id
// @access  Private
exports.getSubCategory = asyncHandler(async (req, res) => {
    const subCategory = await SubCategory.findById(req.params.id)
        .populate('category', 'name');

    if (!subCategory) {
        return res.status(404).json({
            success: false,
            message: 'Sub-category not found'
        });
    }

    res.status(200).json({
        success: true,
        data: subCategory
    });
});

// @desc    Create sub-category
// @route   POST /api/subcategories
// @access  Private/Admin/Manager
exports.createSubCategory = asyncHandler(async (req, res) => {
    // Verify category exists
    const category = await Category.findById(req.body.category);
    if (!category) {
        return res.status(404).json({
            success: false,
            message: 'Category not found'
        });
    }

    const subCategory = await SubCategory.create(req.body);
    await cache.bumpMany(['subCategories:list', 'categories:list', 'products:list'], getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Sub-category created successfully',
        data: subCategory
    });
});

// @desc    Update sub-category
// @route   PUT /api/subcategories/:id
// @access  Private/Admin/Manager
exports.updateSubCategory = asyncHandler(async (req, res) => {
    let subCategory = await SubCategory.findById(req.params.id);

    if (!subCategory) {
        return res.status(404).json({
            success: false,
            message: 'Sub-category not found'
        });
    }

    // If category is being updated, verify it exists
    if (req.body.category) {
        const category = await Category.findById(req.body.category);
        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }
    }

    subCategory = await SubCategory.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    await cache.bumpMany(['subCategories:list', 'categories:list', 'products:list'], getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Sub-category updated successfully',
        data: subCategory
    });
});

// @desc    Delete sub-category
// @route   DELETE /api/subcategories/:id
// @access  Private/Admin
exports.deleteSubCategory = asyncHandler(async (req, res) => {
    const subCategory = await SubCategory.findById(req.params.id);

    if (!subCategory) {
        return res.status(404).json({
            success: false,
            message: 'Sub-category not found'
        });
    }

    // TODO: Check if sub-category has products before deleting
    // const productCount = await Product.countDocuments({ subCategory: req.params.id });
    // if (productCount > 0) {
    //     return res.status(400).json({
    //         success: false,
    //         message: `Cannot delete sub-category. ${productCount} products are using this sub-category`
    //     });
    // }

    await subCategory.deleteOne();
    await cache.bumpMany(['subCategories:list', 'categories:list', 'products:list'], getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Sub-category deleted successfully'
    });
});

// @desc    Get sub-categories by category
// @route   GET /api/subcategories/category/:categoryId
// @access  Private
exports.getSubCategoriesByCategory = asyncHandler(async (req, res) => {
    const subCategories = await SubCategory.find({
        category: req.params.categoryId,
        isActive: true
    }).sort('name');

    res.status(200).json({
        success: true,
        count: subCategories.length,
        data: subCategories
    });
});
