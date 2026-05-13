const mongoose = require('mongoose');

const STATUSES = ['Draft', 'Dispatched', 'Received', 'Cancelled'];

const stockTransferLineSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    qty: { type: Number, required: true, min: 0.0001 },
    unitCost: { type: Number, default: 0, min: 0 },
    // When line was added from inventory (purchase item), optional trace
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    purchaseItemId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { _id: true });

const stockTransferSerialSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    serialOrImei: { type: String, required: true, trim: true },
    fromLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    toLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true }
}, { _id: true });

const stockTransferSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, default: 'default', index: true },
    transferNo: { type: String, required: true, trim: true },
    fromLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    toLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: STATUSES, default: 'Draft' },
    notes: { type: String, trim: true, default: '' },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dispatchedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    receivedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    dispatchedAtUtc: { type: Date, default: null },
    receivedAtUtc: { type: Date, default: null },
    lines: [stockTransferLineSchema],
    serials: [stockTransferSerialSchema]
}, {
    timestamps: true,
    collection: 'stock_transfers'
});

stockTransferSchema.index({ tenantId: 1, transferNo: 1 }, { unique: true });
stockTransferSchema.index({ status: 1 });
stockTransferSchema.index({ fromLocationId: 1 });
stockTransferSchema.index({ toLocationId: 1 });
stockTransferSchema.index({ createdAt: -1 });

module.exports = require('../lib/tenantModel')('StockTransfer', stockTransferSchema);
module.exports.STATUSES = STATUSES;
