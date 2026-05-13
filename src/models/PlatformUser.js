/**
 * Platform Owner accounts (e.g. Inflix LTD). Separate from tenant Users.
 * Not stored in User collection; do not count toward tenant maxUsers.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

const ROLES = ['platform_admin'];

const platformUserSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    passwordHash: {
        type: String,
        required: true,
        select: false
    },
    role: {
        type: String,
        enum: ROLES,
        default: 'platform_admin'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAtUtc: { type: Date, default: () => new Date() },
    updatedAtUtc: { type: Date, default: () => new Date() }
}, {
    collection: 'platform_users',
    timestamps: false
});

platformUserSchema.index({ email: 1 }, { unique: true });
platformUserSchema.index({ isActive: 1 });

platformUserSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.passwordHash);
};

/** Generate JWT for platform console (aud: 'platform' so tenant tokens are rejected). */
platformUserSchema.methods.getSignedJwtToken = function () {
    const secret = config.platformJwtSecret || config.jwtSecret;
    return jwt.sign(
        { id: this._id, aud: 'platform' },
        secret,
        { expiresIn: config.platformJwtExpire || config.jwtExpire || '7d' }
    );
};

module.exports = require('../lib/tenantModel')('PlatformUser', platformUserSchema);
module.exports.ROLES = ROLES;
