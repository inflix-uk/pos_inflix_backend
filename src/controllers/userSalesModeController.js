const asyncHandler = require('../middleware/asyncHandler');
const User = require('../models/User');
const { getEffectiveRetailModeEnabled } = require('../utils/effectiveRetailMode');
const rbacService = require('../services/rbacService');

// @desc    Get current user's sales mode preference and effective mode
// @route   GET /api/settings/my-sales-mode
// @access  Private (settings.sales_mode or settings.manage)
exports.getMySalesMode = asyncHandler(async (req, res) => {
    const canOwn = rbacService.can(req.user, 'settings.sales_mode');
    const canManage = rbacService.can(req.user, 'settings.manage');
    if (!canOwn && !canManage) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    const user = await User.findById(req.user._id).select('preferredRetailModeEnabled').lean();
    const effectiveRetailModeEnabled = await getEffectiveRetailModeEnabled(req.user._id);
    res.status(200).json({
        success: true,
        data: {
            preferredRetailModeEnabled:
                user && typeof user.preferredRetailModeEnabled === 'boolean'
                    ? user.preferredRetailModeEnabled
                    : null,
            effectiveRetailModeEnabled
        }
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
        { preferredRetailModeEnabled: retailModeEnabled },
        { new: true, runValidators: true }
    ).select('preferredRetailModeEnabled');
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({
        success: true,
        data: {
            preferredRetailModeEnabled: user.preferredRetailModeEnabled,
            effectiveRetailModeEnabled: user.preferredRetailModeEnabled
        }
    });
});
