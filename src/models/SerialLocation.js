const mongoose = require('mongoose');

const serialLocationSchema = new mongoose.Schema({
    serialNumber: { type: String, required: true, trim: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: ['available', 'in_transfer', 'adjusted_out'], default: 'available' },
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockTransfer', default: null },
    adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAdjustment', default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true,
    collection: 'serial_locations'
});

serialLocationSchema.index({ tenantId: 1, serialNumber: 1 }, { unique: true });
serialLocationSchema.index({ locationId: 1 });
serialLocationSchema.index({ status: 1, transferId: 1 });
serialLocationSchema.index({ productId: 1, locationId: 1, status: 1 });

module.exports = require('../lib/tenantModel')('SerialLocation', serialLocationSchema);
