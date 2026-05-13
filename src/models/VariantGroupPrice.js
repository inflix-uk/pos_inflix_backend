const mongoose = require('mongoose');

/**
 * Variant-level group pricing for the Rate List (stock/purchase items grouped by variant).
 * Rate List rows are keyed by category + grade + brand + model + capacity; purchase items
 * do not have a productId, so ProductGroupPrice cannot map them. This model stores
 * pricingGroup + variantKey -> price for use in Pricing Groups -> Rate List and POS resolution.
 */
const variantGroupPriceSchema = new mongoose.Schema({
    pricingGroup: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PricingGroup',
        required: true
    },
    /** Normalized key: category + grade + brand + brandModel + capacity (space-separated, uppercase). Matches frontend variantKey. */
    variantKey: {
        type: String,
        required: true,
        trim: true
    },
    price: {
        type: Number,
        required: true,
        min: [0, 'Price cannot be negative']
    },
    tenantId: {
        type: String,
        required: true,
        default: 'default',
        trim: true,
        maxlength: [128, 'Tenant ID cannot exceed 128 characters']
    }
}, { timestamps: true });

// Unique compound index: one price per (tenant, group, variantKey). Used for upsert and lookup.
variantGroupPriceSchema.index({ tenantId: 1, pricingGroup: 1, variantKey: 1 }, { unique: true });

module.exports = require('../lib/tenantModel')('VariantGroupPrice', variantGroupPriceSchema);
