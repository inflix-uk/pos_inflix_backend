const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [8, 'Password must be at least 8 characters'],
        select: false
    },
    /** Legacy: kept for backward compat; synced from first role name when roles are used */
    role: {
        type: String,
        enum: ['admin', 'manager', 'cashier', 'staff', 'warehouse'],
        default: 'cashier'
    },
    /** RBAC: assigned roles (source of truth for permissions) */
    roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }],
    phone: {
        type: String,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastLogin: {
        type: Date
    },
    /** Location scope for non-admin users: only these locations are visible in dashboard/reports. Empty = all (e.g. legacy). */
    assignedLocationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }],
    /** Default location for new sales/repairs and report dashboard selection. */
    defaultLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    /** Tenant identity for SaaS; source of truth for entitlements and scoping. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true
});

userSchema.index({ tenantId: 1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) {
        next();
    }
    const salt = await bcrypt.genSalt(config.bcryptSaltRounds);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare password
userSchema.methods.matchPassword = async function(enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// Generate JWT token (include role for legacy; permissions resolved server-side)
userSchema.methods.getSignedJwtToken = function(isPlatformAdmin = false) {
    return jwt.sign({ id: this._id, role: this.role, isPlatformAdmin }, config.jwtSecret, {
        expiresIn: config.jwtExpire
    });
};

/** Return effective role name for display (first role or legacy role) */
userSchema.methods.getEffectiveRoleName = function() {
    if (this.roles && this.roles.length && this.roles[0].name) return this.roles[0].name;
    return this.role || 'cashier';
};

module.exports = require('../lib/tenantModel')('User', userSchema);
