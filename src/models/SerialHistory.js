const mongoose = require('mongoose');

const serialHistorySchema = new mongoose.Schema({
    serialNumber: { type: String, required: true, trim: true },
    /** sold | removed_from_invoice | returned | sale_deleted | returned_to_supplier | received_from_repair */
    eventType: {
        type: String,
        enum: ['sold', 'removed_from_invoice', 'returned', 'sale_deleted', 'returned_to_supplier', 'received_from_repair'],
        required: true
    },
    /** Sale | SalesReturn | PurchaseReturn */
    referenceType: { type: String, enum: ['Sale', 'SalesReturn', 'PurchaseReturn'], required: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    referenceLabel: { type: String, trim: true, default: '' },
    /** For sold: customer name; for returned: optional */
    customerName: { type: String, trim: true, default: '' },
    /** For returned: in_stock | damaged | refurb | return_to_supplier. For returned_to_supplier: often 'repair'. */
    returnDestination: { type: String, trim: true, default: '' },
    /** Purchase return events: product name, return reason (note), return to (supplier), user who did it */
    productName: { type: String, trim: true, default: '' },
    returnReason: { type: String, trim: true, default: '' },
    returnTo: { type: String, trim: true, default: '' },
    actorName: { type: String, trim: true, default: '' },
}, { timestamps: true });

serialHistorySchema.index({ serialNumber: 1, createdAt: 1 });
serialHistorySchema.index({ serialNumber: 1, eventType: 1 }); // for find-by-serial "returned to supplier" check
serialHistorySchema.index({ eventType: 1 }); // for stock-view distinct(serialNumber, { eventType: 'returned_to_supplier' })

module.exports = require('../lib/tenantModel')('SerialHistory', serialHistorySchema);
