const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');

// @desc    Get all users
// @route   GET /api/users
// @access  Private/Admin
exports.getUsers = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);
    const query = { tenantId };

    if (req.query.role) {
        query.role = req.query.role;
    }

    if (req.query.isActive !== undefined) {
        query.isActive = req.query.isActive === 'true';
    }

    if (req.query.search) {
        query.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { email: { $regex: req.query.search, $options: 'i' } }
        ];
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
        .skip(startIndex)
        .limit(limit)
        .sort('-createdAt');

    res.status(200).json({
        success: true,
        count: users.length,
        total,
        page,
        pages: Math.ceil(total / limit),
        data: users
    });
});

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private/Admin
exports.getUser = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    res.status(200).json({
        success: true,
        data: user
    });
});

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private/Admin
exports.updateUser = asyncHandler(async (req, res) => {
    const { name, email, role, phone, isActive } = req.body;
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    user.name = name || user.name;
    user.email = email || user.email;
    user.role = role || user.role;
    user.phone = phone || user.phone;
    if (isActive !== undefined) user.isActive = isActive;

    await user.save();

    res.status(200).json({
        success: true,
        message: 'User updated successfully',
        data: user
    });
});

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin
exports.deleteUser = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    // Prevent deleting self
    if (user._id.toString() === req.user.id) {
        return res.status(400).json({
            success: false,
            message: 'You cannot delete your own account'
        });
    }

    await user.deleteOne();

    res.status(200).json({
        success: true,
        message: 'User deleted successfully'
    });
});

// @desc    Reset user password
// @route   PUT /api/users/:id/resetpassword
// @access  Private/Admin
exports.resetUserPassword = asyncHandler(async (req, res) => {
    const { newPassword } = req.body;
    const tenantId = getTenantIdFromReq(req);
    const user = await User.findOne({ _id: req.params.id, tenantId }).select('+password');

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    user.password = newPassword;
    await user.save();

    res.status(200).json({
        success: true,
        message: 'Password reset successfully'
    });
});
