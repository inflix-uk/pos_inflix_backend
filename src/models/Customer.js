const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

const customerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Customer name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    email: {
        type: String,
        lowercase: true,
        sparse: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        trim: true
    },
    address: {
        street: String,
        addressLine2: String,
        city: String,
        state: String,
        zipCode: String,
        country: { type: String, default: 'United Kingdom' }
    },
    companyNumber: { type: String, trim: true },
    contactName: { type: String, trim: true },
    mobile: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    currency: { type: String, trim: true, default: 'GBP' },
    loyaltyPoints: {
        type: Number,
        default: 0
    },
    totalPurchases: {
        type: Number,
        default: 0
    },
    /** Outstanding balance (e.g. unpaid invoices) for POS/wholesale */
    balance: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    /** If false, hide from repair ticket customer list (POS/wholesale only). Default true = show everywhere. */
    useInRepairs: {
        type: Boolean,
        default: true
    },
    /** System customer for Retail (Walk-in) mode. Only one should exist; used when no customer is selected. */
    isWalkIn: {
        type: Boolean,
        default: false
    },
    /** Optional pricing group for customer-group pricing. When set, POS uses group price for products that have one; else default price. */
    pricingGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'PricingGroup', default: null },
    /** Portal password (hashed). Only set when admin enables portal access for this customer. */
    password: {
        type: String,
        select: false
    },
    /** Whether portal login is enabled for this customer. */
    portalEnabled: {
        type: Boolean,
        default: false
    },
    /** Tenant for SaaS isolation. Set from req.user.tenantId on create. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true
});

customerSchema.index({ tenantId: 1 });
// Compound: covers getCustomers default query sorted by createdAt
customerSchema.index({ tenantId: 1, createdAt: -1 });
// Compound: covers getCustomers with isActive filter
customerSchema.index({ tenantId: 1, isActive: 1, createdAt: -1 });
// Covers search by name/phone/email
customerSchema.index({ tenantId: 1, name: 1 });

// Hash password before saving (if modified)
customerSchema.pre('save', async function (next) {
    if (this.isModified('password') && this.password) {
        const salt = await bcrypt.genSalt(config.bcryptSaltRounds);
        this.password = await bcrypt.hash(this.password, salt);
    }
    if (this.balance != null && typeof this.balance === 'number') {
        this.balance = Math.round(this.balance * 100) / 100;
    }
    next();
});

// Compare password for portal login
customerSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// Generate JWT for customer portal (tagged type so it can't access admin routes)
customerSchema.methods.getPortalToken = function () {
    return jwt.sign(
        { id: this._id, type: 'customer-portal' },
        config.jwtSecret,
        { expiresIn: config.jwtExpire }
    );
};

module.exports = require('../lib/tenantModel')('Customer', customerSchema);
