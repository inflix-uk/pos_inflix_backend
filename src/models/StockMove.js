const mongoose = require('mongoose');

const stockMoveSchema = new mongoose.Schema({
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockTransfer', default: null },
    adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAdjustment', default: null },
    type: { type: String, enum: ['in', 'out', 'adjust_in', 'adjust_out'], required: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    quantity: { type: Number, default: null },
    serialNumber: { type: String, trim: true, default: null },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true,
    collection: 'stock_moves'
});

stockMoveSchema.index({ transferId: 1 });
stockMoveSchema.index({ tenantId: 1 });
stockMoveSchema.index({ adjustmentId: 1 });
stockMoveSchema.index({ locationId: 1, createdAt: -1 });
stockMoveSchema.index({ serialNumber: 1, createdAt: -1 });

module.exports = require('../lib/tenantModel')('StockMove', stockMoveSchema);
