/**
 * Tenant (organisation) for SaaS multi-tenancy.
 * Source of truth for tenant identity; subscription/entitlements in TenantSubscription.
 */
const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
    tenantId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        maxlength: [128, 'Tenant ID cannot exceed 128 characters']
    },
    /** Subdomain/slug for host-based tenant resolution (e.g. "gnr" for gnr.inflix.uk). Unique, lowercase, alphanumeric + hyphens. */
    subdomain: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        lowercase: true,
        maxlength: [63, 'Subdomain cannot exceed 63 characters'],
        match: [/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^$/, 'Subdomain must be lowercase alphanumeric with hyphens, or empty']
    },
    name: { type: String, trim: true, default: '', maxlength: [200, 'Name cannot exceed 200 characters'] },
    companyName: { type: String, trim: true, default: '', maxlength: [200, 'Company name cannot exceed 200 characters'] },
    email: { type: String, trim: true, lowercase: true, default: '', maxlength: [254, 'Email cannot exceed 254 characters'] },
    phone: { type: String, trim: true, default: '', maxlength: [50, 'Phone cannot exceed 50 characters'] },
    /** Billing contact / address */
    billingAddress: { type: String, trim: true, default: '', maxlength: [500, 'Billing address cannot exceed 500 characters'] },
    billingEmail: { type: String, trim: true, lowercase: true, default: '', maxlength: [254] },
    /** Plan amount and cycle (stored on tenant for display; entitlements from TenantSubscription) */
    billingAmount: { type: Number, default: null, min: 0 },
    billingCycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly', trim: true },
    currency: { type: String, trim: true, default: 'GBP', maxlength: [10] },
    status: {
        type: String,
        enum: ['active', 'suspended'],
        default: 'active',
        trim: true
    },
    createdAtUtc: { type: Date, default: Date.now },
    updatedAtUtc: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'tenants' });

tenantSchema.index({ status: 1 });
// subdomain index is already created by the unique+sparse field options in the schema
tenantSchema.pre('save', function (next) {
    this.updatedAtUtc = new Date();
    next();
});

module.exports = require('../lib/tenantModel')('Tenant', tenantSchema);
