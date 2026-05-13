/**
 * Limit registry: max users, max locations, max repairs per month, etc.
 * Keys are referenced in PlanCatalog.limits and TenantSubscription.overrides.limits.
 */
const mongoose = require('mongoose');

const limitCatalogSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        maxlength: [64, 'Limit key cannot exceed 64 characters']
    },
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: [120, 'Limit name cannot exceed 120 characters']
    },
    description: {
        type: String,
        trim: true,
        default: '',
        maxlength: [500, 'Description cannot exceed 500 characters']
    },
    unit: {
        type: String,
        trim: true,
        default: 'count',
        maxlength: [32, 'Unit cannot exceed 32 characters']
    },
    defaultValue: {
        type: Number,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAtUtc: { type: Date, default: Date.now },
    updatedAtUtc: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'limit_catalog' });

limitCatalogSchema.index({ isActive: 1 });

limitCatalogSchema.pre('save', function (next) {
    this.updatedAtUtc = new Date();
    next();
});

module.exports = require('../lib/tenantModel')('LimitCatalog', limitCatalogSchema);
