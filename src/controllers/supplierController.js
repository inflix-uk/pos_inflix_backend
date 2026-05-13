const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const SUPPLIER_CACHE_NAMESPACES = ['suppliers:list'];
async function invalidateSupplierCaches(tenantId) {
    await cache.bumpMany(SUPPLIER_CACHE_NAMESPACES, tenantId);
}

// @desc    Get all suppliers
// @route   GET /api/suppliers
// @access  Private
exports.getSuppliers = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);

    const params = {
        page, limit,
        isActive: req.query.isActive,
        search: req.query.search || null,
    };

    const payload = await cache.cached(
        { ns: 'suppliers:list', tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = {};

            if (req.query.isActive !== undefined) {
                query.isActive = req.query.isActive === 'true';
            }

            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { phone: { $regex: req.query.search, $options: 'i' } },
                    { email: { $regex: req.query.search, $options: 'i' } },
                    { contactPerson: { $regex: req.query.search, $options: 'i' } }
                ];
            }

            const [total, suppliers] = await Promise.all([
                Supplier.countDocuments(query),
                Supplier.find(query)
                    .skip(startIndex)
                    .limit(limit)
                    .sort('-createdAt')
                    .lean()
            ]);
            return { total, suppliers, pages: Math.ceil(total / limit) };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.suppliers.length,
        total: payload.total,
        page,
        pages: payload.pages,
        data: payload.suppliers
    });
});

// @desc    Get single supplier
// @route   GET /api/suppliers/:id
// @access  Private
exports.getSupplier = asyncHandler(async (req, res) => {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
        return res.status(404).json({
            success: false,
            message: 'Supplier not found'
        });
    }

    res.status(200).json({
        success: true,
        data: supplier
    });
});

// @desc    Create supplier
// @route   POST /api/suppliers
// @access  Private/Admin/Manager
exports.createSupplier = asyncHandler(async (req, res) => {
    const supplier = await Supplier.create(req.body);

    await invalidateSupplierCaches(getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Supplier created successfully',
        data: supplier
    });
});

// @desc    Update supplier
// @route   PUT /api/suppliers/:id
// @access  Private/Admin/Manager
exports.updateSupplier = asyncHandler(async (req, res) => {
    let supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
        return res.status(404).json({
            success: false,
            message: 'Supplier not found'
        });
    }

    supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });

    await invalidateSupplierCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Supplier updated successfully',
        data: supplier
    });
});

// @desc    Delete supplier
// @route   DELETE /api/suppliers/:id
// @access  Private/Admin
exports.deleteSupplier = asyncHandler(async (req, res) => {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
        return res.status(404).json({
            success: false,
            message: 'Supplier not found'
        });
    }

    // Check if supplier has products
    const productCount = await Product.countDocuments({ supplier: req.params.id });

    if (productCount > 0) {
        return res.status(400).json({
            success: false,
            message: `Cannot delete supplier. ${productCount} products are linked to this supplier`
        });
    }

    await supplier.deleteOne();

    await invalidateSupplierCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Supplier deleted successfully'
    });
});

// @desc    Get supplier products
// @route   GET /api/suppliers/:id/products
// @access  Private
exports.getSupplierProducts = asyncHandler(async (req, res) => {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
        return res.status(404).json({
            success: false,
            message: 'Supplier not found'
        });
    }

    const products = await Product.find({ supplier: req.params.id })
        .populate('category', 'name');

    res.status(200).json({
        success: true,
        count: products.length,
        data: products
    });
});
