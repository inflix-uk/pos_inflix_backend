/**
 * Platform Owner auth: login / logout / me. Separate from tenant /api/auth.
 * Platform users are stored in PlatformUser, not User.
 */
const PlatformUser = require('../models/PlatformUser');
const asyncHandler = require('../middleware/asyncHandler');
const bcrypt = require('bcryptjs');
const config = require('../config');

// @desc    Platform login
// @route   POST /api/platform-auth/login
// @access  Public
exports.login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Please provide email and password'
        });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const platformUser = await PlatformUser.findOne({ email: normalizedEmail }).select('+passwordHash');

    if (!platformUser) {
        return res.status(401).json({
            success: false,
            message: 'Invalid credentials'
        });
    }

    if (!platformUser.isActive) {
        return res.status(401).json({
            success: false,
            message: 'Platform account is deactivated'
        });
    }

    const isMatch = await platformUser.matchPassword(password);
    if (!isMatch) {
        return res.status(401).json({
            success: false,
            message: 'Invalid credentials'
        });
    }

    const token = platformUser.getSignedJwtToken();
    res.status(200).json({
        success: true,
        data: {
            email: platformUser.email,
            role: platformUser.role,
            isPlatformAdmin: platformUser.role === 'platform_admin'
        },
        token
    });
});

// @desc    Platform logout (client discards token)
// @route   POST /api/platform-auth/logout
// @access  Private (platform token)
exports.logout = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, message: 'Logged out' });
});

// @desc    Get current platform user
// @route   GET /api/platform-auth/me
// @access  Private (platform token)
exports.me = asyncHandler(async (req, res) => {
    const platformUser = req.platformUser;
    res.status(200).json({
        success: true,
        data: {
            email: platformUser.email,
            role: platformUser.role,
            isPlatformAdmin: platformUser.role === 'platform_admin'
        }
    });
});
