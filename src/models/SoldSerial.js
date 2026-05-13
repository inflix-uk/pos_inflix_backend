const mongoose = require('mongoose');

const soldSerialSchema = new mongoose.Schema({
    serialNumber: { type: String, required: true, trim: true },
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
    soldAt: { type: Date, default: Date.now },
    /** After return: 'sold' | 'returned' */
    status: { type: String, enum: ['sold', 'returned'], default: 'sold' },
    /** When status is 'returned': where the unit went */
    returnDestination: { type: String, enum: ['in_stock', 'damaged', 'refurb', 'return_to_supplier'], default: null },
    returnedAt: { type: Date, default: null },
    salesReturnId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesReturn', default: null },
}, { timestamps: true });

soldSerialSchema.index({ serialNumber: 1 }, { unique: true });
soldSerialSchema.index({ saleId: 1 });
soldSerialSchema.index({ status: 1 }); // for stock-view distinct and filters
// Compound: covers distinctSerialNumbersSoldOnActiveSales aggregation ($match status + $lookup saleId)
soldSerialSchema.index({ status: 1, saleId: 1 });
// Compound: covers stock-view's returned-to-supplier distinct (status='returned' + returnDestination='return_to_supplier').
// Sparse because returnDestination is null on every non-returned row (the majority).
soldSerialSchema.index(
    { status: 1, returnDestination: 1 },
    { sparse: true, partialFilterExpression: { status: 'returned' } }
);

module.exports = require('../lib/tenantModel')('SoldSerial', soldSerialSchema);
