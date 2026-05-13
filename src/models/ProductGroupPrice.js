const mongoose = require('mongoose');

const productGroupPriceSchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    pricingGroup: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PricingGroup',
        required: true
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

productGroupPriceSchema.index({ tenantId: 1, product: 1, pricingGroup: 1 }, { unique: true });

module.exports = require('../lib/tenantModel')('ProductGroupPrice', productGroupPriceSchema);
