const asyncHandler = require('../middleware/asyncHandler');
const User = require('../models/User');
const { getUserSalesModeFields } = require('../utils/effectiveRetailMode');
const rbacService = require('../services/rbacService');
const { invalidateAuthCaches } = require('../middleware/auth');

// @desc    Get current user's sales mode preference and effective mode
// @route   GET /api/settings/my-sales-mode
// @access  Private (settings.sales_mode or settings.manage)
exports.getMySalesMode = asyncHandler(async (req, res) => {
    const canOwn = rbacService.can(req.user, 'settings.sales_mode');
    const canManage = rbacService.can(req.user, 'settings.manage');
    if (!canOwn && !canManage) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    const salesMode = await getUserSalesModeFields(req.user._id);
    res.status(200).json({
        success: true,
        data: salesMode
    });
});

// @desc    Save current user's retail vs wholesale preference
// @route   PUT /api/settings/my-sales-mode
// @access  Private (settings.sales_mode)
exports.updateMySalesMode = asyncHandler(async (req, res) => {
    if (!rbacService.can(req.user, 'settings.sales_mode')) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    const { retailModeEnabled } = req.body;
    if (typeof retailModeEnabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'retailModeEnabled must be a boolean' });
    }
    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: { preferredRetailModeEnabled: retailModeEnabled } },
        { new: true, runValidators: true }
    ).select('preferredRetailModeEnabled tenantId');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }
    invalidateAuthCaches(user._id, user.tenantId);
    const salesMode = await getUserSalesModeFields(user._id);
    res.status(200).json({
        success: true,
        data: salesMode
    });
});
