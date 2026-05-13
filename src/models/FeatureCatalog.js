/**
 * Feature registry: every feature that can be toggled per tenant/plan.
 * New features added here appear automatically in the platform console.
 */
const mongoose = require('mongoose');

const featureCatalogSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        maxlength: [64, 'Feature key cannot exceed 64 characters']
    },
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: [120, 'Feature name cannot exceed 120 characters']
    },
    description: {
        type: String,
        trim: true,
        default: '',
        maxlength: [500, 'Description cannot exceed 500 characters']
    },
    category: {
        type: String,
        trim: true,
        default: 'Core',
        maxlength: [64, 'Category cannot exceed 64 characters']
    },
    defaultEnabled: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAtUtc: { type: Date, default: Date.now },
    updatedAtUtc: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'feature_catalog' });

featureCatalogSchema.index({ isActive: 1, category: 1 });

featureCatalogSchema.pre('save', function (next) {
    this.updatedAtUtc = new Date();
    next();
});

module.exports = require('../lib/tenantModel')('FeatureCatalog', featureCatalogSchema);
