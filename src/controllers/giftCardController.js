const GiftCard = require('../models/GiftCard');
const asyncHandler = require('../middleware/asyncHandler');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { getTenantIdFromReq } = require('../middleware/auth');

const GIFT_CARDS_NS = 'giftCards:list';
async function invalidateGiftCardsCache(tenantId) {
    await cache.bumpNs(GIFT_CARDS_NS, tenantId);
}

// Helper to format date for frontend
const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
};

// Helper to transform gift card for frontend
const transformGiftCard = (giftCard) => {
    const obj = giftCard.toObject();
    return {
        id: obj._id.toString(),
        giftCard: obj.code,
        customer: obj.customer,
        issuedDate: formatDate(obj.issuedDate),
        expiryDate: formatDate(obj.expiryDate),
        amount: obj.amount,
        balance: obj.balance,
        status: obj.status
    };
};

// @desc    Get all gift cards
// @route   GET /api/gift-cards
// @access  Private
exports.getGiftCards = asyncHandler(async (req, res) => {
    const params = {
        status: req.query.status || null,
        search: req.query.search || null
    };

    const transformedGiftCards = await cache.cached(
        { ns: GIFT_CARDS_NS, tenantId: getTenantIdFromReq(req), params, ttlSec: TTL.CATALOG },
        async () => {
            const query = {};
            if (req.query.status && req.query.status !== 'All') {
                query.status = req.query.status;
            }
            if (req.query.search) {
                query.$or = [
                    { code: { $regex: req.query.search, $options: 'i' } },
                    { 'customer.name': { $regex: req.query.search, $options: 'i' } }
                ];
            }
            const giftCards = await GiftCard.find(query).sort('-createdAt');
            // Transform for frontend compatibility
            return giftCards.map(transformGiftCard);
        }
    );

    res.status(200).json(transformedGiftCards);
});

// @desc    Get single gift card
// @route   GET /api/gift-cards/:id
// @access  Private
exports.getGiftCard = asyncHandler(async (req, res) => {
    const giftCard = await GiftCard.findById(req.params.id);

    if (!giftCard) {
        return res.status(404).json({
            success: false,
            message: 'Gift card not found'
        });
    }

    res.status(200).json(transformGiftCard(giftCard));
});

// @desc    Create gift card
// @route   POST /api/gift-cards
// @access  Private
exports.createGiftCard = asyncHandler(async (req, res) => {
    const giftCard = await GiftCard.create({
        code: req.body.giftCard || req.body.code,
        customer: req.body.customer,
        issuedDate: req.body.issuedDate ? new Date(req.body.issuedDate) : new Date(),
        expiryDate: new Date(req.body.expiryDate),
        amount: req.body.amount,
        balance: req.body.balance !== undefined ? req.body.balance : req.body.amount,
        status: req.body.status || 'Active'
    });
    await invalidateGiftCardsCache(getTenantIdFromReq(req));

    res.status(201).json(transformGiftCard(giftCard));
});

// @desc    Update gift card
// @route   PUT /api/gift-cards/:id
// @access  Private
exports.updateGiftCard = asyncHandler(async (req, res) => {
    let giftCard = await GiftCard.findById(req.params.id);

    if (!giftCard) {
        return res.status(404).json({
            success: false,
            message: 'Gift card not found'
        });
    }

    const updateData = {};
    if (req.body.giftCard || req.body.code) updateData.code = req.body.giftCard || req.body.code;
    if (req.body.customer) updateData.customer = req.body.customer;
    if (req.body.issuedDate) updateData.issuedDate = new Date(req.body.issuedDate);
    if (req.body.expiryDate) updateData.expiryDate = new Date(req.body.expiryDate);
    if (req.body.amount !== undefined) updateData.amount = req.body.amount;
    if (req.body.balance !== undefined) updateData.balance = req.body.balance;
    if (req.body.status) updateData.status = req.body.status;

    giftCard = await GiftCard.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true
    });
    await invalidateGiftCardsCache(getTenantIdFromReq(req));

    res.status(200).json(transformGiftCard(giftCard));
});

// @desc    Delete gift card
// @route   DELETE /api/gift-cards/:id
// @access  Private/Admin
exports.deleteGiftCard = asyncHandler(async (req, res) => {
    const giftCard = await GiftCard.findById(req.params.id);

    if (!giftCard) {
        return res.status(404).json({
            success: false,
            message: 'Gift card not found'
        });
    }

    await giftCard.deleteOne();
    await invalidateGiftCardsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Gift card deleted successfully'
    });
});

// @desc    Redeem gift card balance
// @route   PUT /api/gift-cards/:id/redeem
// @access  Private
exports.redeemGiftCard = asyncHandler(async (req, res) => {
    const { amount } = req.body;

    const giftCard = await GiftCard.findById(req.params.id);

    if (!giftCard) {
        return res.status(404).json({
            success: false,
            message: 'Gift card not found'
        });
    }

    if (giftCard.status === 'Expired') {
        return res.status(400).json({
            success: false,
            message: 'Gift card has expired'
        });
    }

    if (giftCard.balance < amount) {
        return res.status(400).json({
            success: false,
            message: 'Insufficient balance'
        });
    }

    giftCard.balance -= amount;

    if (giftCard.balance === 0) {
        giftCard.status = 'Redeemed';
    }

    await giftCard.save();
    await invalidateGiftCardsCache(getTenantIdFromReq(req));

    res.status(200).json(transformGiftCard(giftCard));
});
