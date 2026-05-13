const mongoose = require('mongoose');

const REASON_CODES = ['COUNT_CORRECTION', 'DAMAGED', 'LOST_STOLEN', 'SUPPLIER_DISCREPANCY', 'DATA_FIX', 'OTHER'];
const STATUSES = ['Draft', 'Posted', 'Cancelled'];
const SERIAL_DIRECTIONS = ['IN', 'OUT'];

const stockAdjustmentLineSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    deltaQty: { type: Number, required: true }, // positive = IN, negative = OUT
    unitCostSnapshot: { type: Number, default: 0, min: 0 },
    valueSnapshot: { type: Number, default: 0, min: 0 },
    costMissing: { type: Boolean, default: false }
}, { _id: true });

const stockAdjustmentSerialSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    serialOrImei: { type: String, required: true, trim: true },
    direction: { type: String, enum: SERIAL_DIRECTIONS, required: true },
    unitCostSnapshot: { type: Number, default: 0, min: 0 },
    valueSnapshot: { type: Number, default: 0, min: 0 },
    costMissing: { type: Boolean, default: false }
}, { _id: true });

const stockAdjustmentSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, default: 'default', index: true },
    adjustmentNo: { type: String, required: true, trim: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: STATUSES, default: 'Draft' },
    reasonCode: { type: String, enum: REASON_CODES, required: true },
    notes: { type: String, trim: true, default: '' },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedAtUtc: { type: Date, default: null },
    cancelledAtUtc: { type: Date, default: null },
    totalQtyIn: { type: Number, default: 0 },
    totalQtyOut: { type: Number, default: 0 },
    totalValueIn: { type: Number, default: 0 },
    totalValueOut: { type: Number, default: 0 },
    lines: [stockAdjustmentLineSchema],
    serials: [stockAdjustmentSerialSchema]
}, {
    timestamps: true,
    collection: 'stock_adjustments'
});

stockAdjustmentSchema.index({ tenantId: 1, adjustmentNo: 1 }, { unique: true });
stockAdjustmentSchema.index({ status: 1 });
stockAdjustmentSchema.index({ locationId: 1 });
stockAdjustmentSchema.index({ reasonCode: 1 });
stockAdjustmentSchema.index({ createdAt: -1 });
stockAdjustmentSchema.index({ 'serials.serialOrImei': 1 });

module.exports = require('../lib/tenantModel')('StockAdjustment', stockAdjustmentSchema);
module.exports.STATUSES = STATUSES;
module.exports.REASON_CODES = REASON_CODES;
module.exports.SERIAL_DIRECTIONS = SERIAL_DIRECTIONS;
