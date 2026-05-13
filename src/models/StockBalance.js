const mongoose = require('mongoose');

const stockBalanceSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true,
    collection: 'stock_balances'
});

stockBalanceSchema.index({ tenantId: 1, productId: 1, locationId: 1 }, { unique: true });
stockBalanceSchema.index({ locationId: 1 });

module.exports = require('../lib/tenantModel')('StockBalance', stockBalanceSchema);
