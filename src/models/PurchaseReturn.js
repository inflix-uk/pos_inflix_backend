const mongoose = require('mongoose');

/**
 * One line in a purchase return: reference to a purchase item and what we're returning.
 * For serial items: imeisReturned lists IMEIs to return (removed from purchase item).
 * For non-serial: quantityReturned reduces the item's quantity.
 */
const purchaseReturnItemSchema = new mongoose.Schema({
    purchaseItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** Non-serial (other) items: number of units returned */
    quantityReturned: { type: Number, default: 0 },
    /** Serial items: IMEIs being returned (each removed from purchase item) */
    imeisReturned: [{ type: String }],
    /** Snapshot: unit cost at return time */
    purchasePrice: { type: Number, default: 0 },
}, { _id: true });

const purchaseReturnSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, default: 'default', index: true },
    returnNumber: { type: String, required: true, trim: true },
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true },
    date: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['Pending', 'Sent', 'Received by Supplier'],
        default: 'Pending'
    },
    note: { type: String, default: '' },
    items: [purchaseReturnItemSchema],
    /** Total value returned (sum of purchasePrice * qty or * imeis.length) */
    totalAmount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
    timestamps: true,
    collection: 'purchasereturns'
});

purchaseReturnSchema.index({ tenantId: 1, returnNumber: 1 }, { unique: true });

module.exports = require('../lib/tenantModel')('PurchaseReturn', purchaseReturnSchema);
