const mongoose = require('mongoose');

const pricingGroupSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Pricing group name is required'],
        trim: true,
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    tenantId: {
        type: String,
        required: true,
        default: 'default',
        trim: true,
        maxlength: [128, 'Tenant ID cannot exceed 128 characters']
    }
}, { timestamps: true });

pricingGroupSchema.index({ tenantId: 1 });

module.exports = require('../lib/tenantModel')('PricingGroup', pricingGroupSchema);
