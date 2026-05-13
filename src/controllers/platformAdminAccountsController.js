/**
 * Platform Owner Console: CRUD for platform admin accounts (PlatformUser).
 * All routes require requirePlatformAuth.
 */

const PlatformUser = require('../models/PlatformUser');
const asyncHandler = require('../middleware/asyncHandler');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { validatePassword } = require('../utils/passwordPolicy');

exports.list = asyncHandler(async (req, res) => {
    const list = await PlatformUser.find()
        .select('-passwordHash')
        .sort({ email: 1 })
        .lean();
    const data = list.map((u) => ({
        _id: u._id,
        email: u.email,
        role: u.role,
        isActive: u.isActive,
        createdAtUtc: u.createdAtUtc,
        updatedAtUtc: u.updatedAtUtc,
    }));
    res.status(200).json({ success: true, data });
});

exports.create = asyncHandler(async (req, res) => {
    const { email, password, role } = req.body;
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) {
        return res.status(400).json({ success: false, message: pwdCheck.message });
    }
    const existing = await PlatformUser.findOne({ email: normalizedEmail });
    if (existing) {
        return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    const salt = await bcrypt.genSalt(config.bcryptSaltRounds || 10);
    const passwordHash = await bcrypt.hash(password, salt);
    const roleValue = role === 'platform_admin' ? 'platform_admin' : 'platform_admin';
    const user = await PlatformUser.create({
        email: normalizedEmail,
        passwordHash,
        role: roleValue,
        isActive: true,
    });
    const data = {
        _id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAtUtc: user.createdAtUtc,
        updatedAtUtc: user.updatedAtUtc,
    };
    res.status(201).json({ success: true, data, message: 'Platform admin created' });
});

exports.getOne = asyncHandler(async (req, res) => {
    const user = await PlatformUser.findById(req.params.id).select('-passwordHash').lean();
    if (!user) return res.status(404).json({ success: false, message: 'Platform admin not found' });
    res.status(200).json({ success: true, data: user });
});

exports.update = asyncHandler(async (req, res) => {
    const { email, isActive, newPassword } = req.body;
    const user = await PlatformUser.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Platform admin not found' });
    if (email !== undefined) {
        const normalized = email.toLowerCase().trim();
        if (!normalized) return res.status(400).json({ success: false, message: 'Email cannot be empty' });
        const existing = await PlatformUser.findOne({ email: normalized, _id: { $ne: user._id } });
        if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });
        user.email = normalized;
    }
    if (isActive !== undefined) user.isActive = !!isActive;
    if (newPassword) {
        const pwdCheck = validatePassword(newPassword);
        if (!pwdCheck.valid) return res.status(400).json({ success: false, message: pwdCheck.message });
        const salt = await bcrypt.genSalt(config.bcryptSaltRounds || 10);
        user.passwordHash = await bcrypt.hash(newPassword, salt);
    }
    user.updatedAtUtc = new Date();
    await user.save();
    const data = {
        _id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAtUtc: user.createdAtUtc,
        updatedAtUtc: user.updatedAtUtc,
    };
    res.status(200).json({ success: true, data, message: 'Platform admin updated' });
});

exports.deleteOne = asyncHandler(async (req, res) => {
    const user = await PlatformUser.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Platform admin not found' });
    const count = await PlatformUser.countDocuments({ isActive: true });
    if (count <= 1) {
        return res.status(400).json({
            success: false,
            message: 'Cannot delete the last active platform admin. Create another admin first.',
        });
    }
    await user.deleteOne();
    res.status(200).json({ success: true, message: 'Platform admin deleted' });
});
