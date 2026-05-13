const Coupon = require('../models/Coupon');
const asyncHandler = require('../middleware/asyncHandler');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const COUPONS_LIST_NS = 'coupons:list';
async function invalidateCouponsCache(tenantId) {
    await cache.bumpNs(COUPONS_LIST_NS, tenantId);
}

// @desc    Get all coupons
// @route   GET /api/coupons
// @access  Private
exports.getCoupons = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;

    const params = {
        page, limit,
        status: req.query.status || null,
        type: req.query.type || null,
        search: req.query.search || null
    };

    const tenantId = getTenantIdFromReq(req);
    const payload = await cache.cached(
        { ns: COUPONS_LIST_NS, tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = {};
            if (req.query.status) {
                query.status = req.query.status;
            }
            if (req.query.type) {
                query.type = req.query.type;
            }
            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { code: { $regex: req.query.search, $options: 'i' } },
                    { description: { $regex: req.query.search, $options: 'i' } }
                ];
            }
            const [total, coupons] = await Promise.all([
                Coupon.countDocuments(query),
                Coupon.find(query)
                    .skip(startIndex)
                    .limit(limit)
                    .sort('-createdAt')
                    .lean()
            ]);
            return { total, coupons };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.coupons.length,
        total: payload.total,
        page,
        pages: Math.ceil(payload.total / limit),
        data: payload.coupons
    });
});

// @desc    Get single coupon
// @route   GET /api/coupons/:id
// @access  Private
exports.getCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Coupon not found'
        });
    }

    res.status(200).json({
        success: true,
        data: coupon
    });
});

// @desc    Get coupon by code
// @route   GET /api/coupons/code/:code
// @access  Private
exports.getCouponByCode = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findOne({ code: req.params.code.toUpperCase() });

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Coupon not found'
        });
    }

    res.status(200).json({
        success: true,
        data: coupon
    });
});

// @desc    Validate coupon
// @route   POST /api/coupons/validate
// @access  Private
exports.validateCoupon = asyncHandler(async (req, res) => {
    const { code, orderAmount } = req.body;

    const coupon = await Coupon.findOne({ code: code.toUpperCase() });

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Invalid coupon code'
        });
    }

    // Check if coupon is active
    if (coupon.status !== 'Active') {
        return res.status(400).json({
            success: false,
            message: 'This coupon is no longer active'
        });
    }

    // Check if coupon has started
    const now = new Date();
    if (coupon.startDate > now) {
        return res.status(400).json({
            success: false,
            message: 'This coupon is not yet valid'
        });
    }

    // Check if coupon has expired
    if (coupon.endDate < now) {
        return res.status(400).json({
            success: false,
            message: 'This coupon has expired'
        });
    }

    // Check usage limit
    if (coupon.usedCount >= coupon.limit) {
        return res.status(400).json({
            success: false,
            message: 'This coupon has reached its usage limit'
        });
    }

    // Check minimum purchase amount
    if (orderAmount && coupon.minPurchaseAmount > orderAmount) {
        return res.status(400).json({
            success: false,
            message: `Minimum purchase amount of $${coupon.minPurchaseAmount} required`
        });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.type === 'Percentage') {
        discountAmount = (orderAmount * coupon.discount) / 100;
        if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
            discountAmount = coupon.maxDiscountAmount;
        }
    } else {
        discountAmount = coupon.discount;
    }

    res.status(200).json({
        success: true,
        message: 'Coupon is valid',
        data: {
            coupon,
            discountAmount: Math.round(discountAmount * 100) / 100
        }
    });
});

// @desc    Create coupon
// @route   POST /api/coupons
// @access  Private
exports.createCoupon = asyncHandler(async (req, res) => {
    // Ensure code is uppercase
    if (req.body.code) {
        req.body.code = req.body.code.toUpperCase();
    }

    const coupon = await Coupon.create(req.body);
    await invalidateCouponsCache(getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Coupon created successfully',
        data: coupon
    });
});

// @desc    Update coupon
// @route   PUT /api/coupons/:id
// @access  Private
exports.updateCoupon = asyncHandler(async (req, res) => {
    let coupon = await Coupon.findById(req.params.id);

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Coupon not found'
        });
    }

    // Ensure code is uppercase
    if (req.body.code) {
        req.body.code = req.body.code.toUpperCase();
    }

    coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    await invalidateCouponsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Coupon updated successfully',
        data: coupon
    });
});

// @desc    Delete coupon
// @route   DELETE /api/coupons/:id
// @access  Private/Admin
exports.deleteCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Coupon not found'
        });
    }

    await coupon.deleteOne();
    await invalidateCouponsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Coupon deleted successfully'
    });
});

// @desc    Use coupon (increment usage count)
// @route   PUT /api/coupons/:id/use
// @access  Private
exports.useCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);

    if (!coupon) {
        return res.status(404).json({
            success: false,
            message: 'Coupon not found'
        });
    }

    if (coupon.usedCount >= coupon.limit) {
        return res.status(400).json({
            success: false,
            message: 'Coupon usage limit reached'
        });
    }

    coupon.usedCount += 1;
    await coupon.save();
    await invalidateCouponsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Coupon usage recorded',
        data: coupon
    });
});
