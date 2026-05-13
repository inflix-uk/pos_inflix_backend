/**
 * Plan definitions: starter, pro, enterprise. Each plan has dynamic features and limits.
 */
const mongoose = require('mongoose');

const planCatalogSchema = new mongoose.Schema({
    planKey: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        maxlength: [64, 'Plan key cannot exceed 64 characters']
    },
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: [120, 'Plan name cannot exceed 120 characters']
    },
    description: {
        type: String,
        trim: true,
        default: '',
        maxlength: [500, 'Description cannot exceed 500 characters']
    },
    /** Optional price metadata (e.g. monthly amount, currency) – not used for enforcement */
    priceMetadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    /** Dynamic: { [featureKey]: boolean } */
    features: {
        type: Map,
        of: Boolean,
        default: () => new Map()
    },
    /** Dynamic: { [limitKey]: number | null } */
    limits: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: () => new Map()
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAtUtc: { type: Date, default: Date.now },
    updatedAtUtc: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'plan_catalog' });

planCatalogSchema.index({ isActive: 1 });

planCatalogSchema.pre('save', function (next) {
    this.updatedAtUtc = new Date();
    next();
});

module.exports = require('../lib/tenantModel')('PlanCatalog', planCatalogSchema);
