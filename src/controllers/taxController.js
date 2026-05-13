const Tax = require('../models/Tax');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const TAXES_NS = 'taxes:list';
async function invalidateTaxesCache(tenantId) {
    await cache.bumpNs(TAXES_NS, tenantId);
}

// @desc    Get all taxes
// @route   GET /api/settings/taxes
// @access  Private
exports.getTaxes = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const params = {
        scope: 'list',
        isActive: req.query.isActive,
        type: req.query.type || null
    };
    const taxes = await cache.cached(
        { ns: TAXES_NS, tenantId, params, ttlSec: TTL.REFERENCE },
        async () => {
            const query = {};
            if (req.query.isActive !== undefined) {
                query.isActive = req.query.isActive === 'true';
            }
            if (req.query.type) {
                query.type = req.query.type;
            }
            return await Tax.find(query).sort({ isDefault: -1, name: 1 }).lean();
        }
    );

    res.status(200).json({
        success: true,
        count: taxes.length,
        data: taxes
    });
});

// @desc    Get single tax
// @route   GET /api/settings/taxes/:id
// @access  Private
exports.getTax = asyncHandler(async (req, res) => {
    const tax = await Tax.findById(req.params.id);

    if (!tax) {
        return res.status(404).json({
            success: false,
            message: 'Tax not found'
        });
    }

    res.status(200).json({
        success: true,
        data: tax
    });
});

// @desc    Get active taxes for dropdowns
// @route   GET /api/settings/taxes/active
// @access  Private
exports.getActiveTaxes = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const taxes = await cache.cached(
        { ns: TAXES_NS, tenantId, params: { scope: 'active' }, ttlSec: TTL.REFERENCE },
        async () => await Tax.find({ isActive: true }).sort({ isDefault: -1, name: 1 }).lean()
    );

    res.status(200).json({
        success: true,
        count: taxes.length,
        data: taxes
    });
});

// @desc    Create tax
// @route   POST /api/settings/taxes
// @access  Private/Admin/Manager
exports.createTax = asyncHandler(async (req, res) => {
    const {
        name,
        rate,
        type,
        code,
        description,
        isCompound,
        isDefault,
        isActive
    } = req.body;

    // If this is the first tax or set as default, make it default
    const existingTaxes = await Tax.countDocuments();
    const shouldBeDefault = existingTaxes === 0 || isDefault;

    // If setting as default, unset other defaults
    if (shouldBeDefault) {
        await Tax.updateMany({}, { isDefault: false });
    }

    const tax = await Tax.create({
        name,
        rate,
        type,
        code,
        description,
        isCompound,
        isDefault: shouldBeDefault,
        isActive: isActive !== undefined ? isActive : true,
        createdBy: req.user._id
    });
    await invalidateTaxesCache(getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Tax created successfully',
        data: tax
    });
});

// @desc    Update tax
// @route   PUT /api/settings/taxes/:id
// @access  Private/Admin/Manager
exports.updateTax = asyncHandler(async (req, res) => {
    let tax = await Tax.findById(req.params.id);

    if (!tax) {
        return res.status(404).json({
            success: false,
            message: 'Tax not found'
        });
    }

    // If setting as default, unset other defaults
    if (req.body.isDefault) {
        await Tax.updateMany(
            { _id: { $ne: req.params.id } },
            { isDefault: false }
        );
    }

    const updateData = { ...req.body, updatedBy: req.user._id };

    tax = await Tax.findByIdAndUpdate(
        req.params.id,
        updateData,
        {
            new: true,
            runValidators: true
        }
    );
    await invalidateTaxesCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Tax updated successfully',
        data: tax
    });
});

// @desc    Delete tax
// @route   DELETE /api/settings/taxes/:id
// @access  Private/Admin
exports.deleteTax = asyncHandler(async (req, res) => {
    const tax = await Tax.findById(req.params.id);

    if (!tax) {
        return res.status(404).json({
            success: false,
            message: 'Tax not found'
        });
    }

    const wasDefault = tax.isDefault;

    await tax.deleteOne();

    // If deleted tax was default, set another as default
    if (wasDefault) {
        const firstTax = await Tax.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (firstTax) {
            firstTax.isDefault = true;
            await firstTax.save();
        }
    }
    await invalidateTaxesCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Tax deleted successfully'
    });
});

// @desc    Set tax as default
// @route   PUT /api/settings/taxes/:id/set-default
// @access  Private/Admin/Manager
exports.setDefaultTax = asyncHandler(async (req, res) => {
    const tax = await Tax.findById(req.params.id);

    if (!tax) {
        return res.status(404).json({
            success: false,
            message: 'Tax not found'
        });
    }

    // Unset all defaults
    await Tax.updateMany({}, { isDefault: false });

    // Set this one as default
    tax.isDefault = true;
    tax.updatedBy = req.user._id;
    await tax.save();
    await invalidateTaxesCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Tax set as default successfully',
        data: tax
    });
});
