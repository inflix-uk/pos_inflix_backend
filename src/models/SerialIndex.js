/**
 * Fast read model: source-of-truth index for serial/IMEI status, cost, product, location.
 * Kept in sync via hooks on Purchase, Sale, StockTransfer, StockAdjustment, SerialLocation.
 * Used by find-in-stock-serials for fast lookup (with Redis cache).
 */
const mongoose = require('mongoose');
const { normalizeSerial } = require('../utils/serialUtil');

const STATUS = [
    'in_stock',
    'sold',
    'returned_to_supplier',
    'in_transfer',
    'adjusted_out',
    'not_found'
];

const serialIndexSchema = new mongoose.Schema({
    /** Tenant/org identifier for SaaS; default 'default' for single-tenant. */
    tenantId: { type: String, required: true, default: 'default' },
    /** Normalized serial (trim, consistent with stock adjustment/transfer). */
    serial: { type: String, required: true, trim: true },
    status: { type: String, enum: STATUS, required: true, default: 'not_found' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    productNameSnapshot: { type: String, default: '' },
    skuSnapshot: { type: String, default: '' },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    purchaseItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    unitCost: { type: Number, default: null },
    salePrice: { type: Number, default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    /** For sold: sale reference/customer (populated from SoldSerial when needed). */
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    saleReferenceSnapshot: { type: String, default: '' },
    customerNameSnapshot: { type: String, default: '' },
    /** Purchase date for "best price" tie-break. */
    purchaseDate: { type: Date, default: null }
}, {
    timestamps: true,
    collection: 'serial_index'
});

serialIndexSchema.index({ tenantId: 1, serial: 1 }, { unique: true });
serialIndexSchema.index({ tenantId: 1, status: 1 });
serialIndexSchema.index({ tenantId: 1, locationId: 1, status: 1 });
serialIndexSchema.index({ tenantId: 1, productId: 1 });

serialIndexSchema.statics.normalizeSerial = normalizeSerial;

module.exports = require('../lib/tenantModel')('SerialIndex', serialIndexSchema);
module.exports.STATUS = Object.freeze(STATUS.reduce((o, s) => ({ ...o, [s]: s }), {}));
