/**
 * Per-tenant subscription: plan + overrides. Source of truth for entitlements.
 */
const mongoose = require('mongoose');

const tenantSubscriptionSchema = new mongoose.Schema({
    tenantId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        maxlength: [128, 'Tenant ID cannot exceed 128 characters']
    },
    subscriptionType: {
        type: String,
        enum: ['plan', 'custom'],
        default: 'plan'
    },
    planKey: {
        type: String,
        trim: true,
        lowercase: true,
        default: '',
        maxlength: [64, 'Plan key cannot exceed 64 characters']
    },
    /** Overrides: take precedence over plan. { [featureKey]: boolean } */
    overrides: {
        features: {
            type: Map,
            of: Boolean,
            default: () => new Map()
        },
        limits: {
            type: Map,
            of: mongoose.Schema.Types.Mixed,
            default: () => new Map()
        }
    },
    /** Subscription period: start and end (for display on platform + tenant billing page). */
    startDate: { type: Date, default: null },
    expireDate: { type: Date, default: null },
    createdAtUtc: { type: Date, default: Date.now },
    updatedAtUtc: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'tenant_subscriptions' });

tenantSubscriptionSchema.index({ planKey: 1 });

tenantSubscriptionSchema.pre('save', function (next) {
    this.updatedAtUtc = new Date();
    next();
});

module.exports = require('../lib/tenantModel')('TenantSubscription', tenantSubscriptionSchema);
