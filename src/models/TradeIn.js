const mongoose = require('mongoose');

/**
 * A trade-in: a walk-in customer sells us one or more devices.
 *
 * Lifecycle:
 *  - draft: created when staff start adding photos / open the phone QR. Holds the photos,
 *    the phone upload token and the customer's terms acceptance. Auto-deleted after
 *    `expiresAt` (TTL index) if never completed.
 *  - completed: the items were added to stock as a normal Purchase under the "Trade-in"
 *    supplier account (purchaseId). The item list below is a snapshot of that purchase.
 */

const tradeInItemSchema = new mongoose.Schema({
    purchaseItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    description: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },
    grade: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    brandModel: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    colour: { type: String, trim: true, default: '' },
    imeis: [{ type: String, trim: true }],
    isOtherItem: { type: Boolean, default: false },
    barcode: { type: String, trim: true, default: '' },
    quantity: { type: Number, default: 0 },
    purchasePrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationName: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' }
}, { _id: false });

const tradeInSchema = new mongoose.Schema({
    /** TI-000001. Reserved when completion starts, so drafts normally have none. */
    reference: { type: String, trim: true },
    status: { type: String, enum: ['draft', 'completed'], default: 'draft' },

    customer: {
        name: { type: String, trim: true, maxlength: [100, 'Name cannot exceed 100 characters'], default: '' },
        phone: { type: String, trim: true, maxlength: [40, 'Mobile cannot exceed 40 characters'], default: '' },
        email: { type: String, trim: true, lowercase: true, maxlength: [254, 'Email is too long'], default: '' }
    },
    notes: { type: String, trim: true, maxlength: [2000, 'Notes cannot exceed 2000 characters'], default: '' },

    items: { type: [tradeInItemSchema], default: [] },
    totalAmount: { type: Number, default: 0, min: 0 },
    totalUnits: { type: Number, default: 0, min: 0 },
    payoutMethod: { type: String, enum: ['cash', 'bank', 'card'], default: 'cash' },

    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    purchaseNumber: { type: String, trim: true, default: '' },

    /** Terms text as shown to the customer when they accepted (copied from Settings at completion). */
    termsText: { type: String, default: '' },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },
    termsAcceptedVia: { type: String, enum: ['desktop', 'phone', null], default: null },

    /** sha256 of the phone upload token; the raw token only lives in the QR code. */
    uploadTokenHash: { type: String, default: null },
    uploadTokenExpiresAt: { type: Date, default: null },

    /** Short-lived lock so a double click on "Complete" can't create two purchases. */
    completing: { type: Boolean, default: false },
    completingAt: { type: Date, default: null },

    date: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },

    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: 128 },

    /** Drafts only: MongoDB deletes the draft after this time. Cleared on completion. */
    expiresAt: { type: Date, default: null }
}, {
    timestamps: true,
    collection: 'tradeins'
});

tradeInSchema.index({ reference: 1 }, { unique: true, sparse: true });
tradeInSchema.index({ uploadTokenHash: 1 }, { sparse: true });
tradeInSchema.index({ tenantId: 1, status: 1, completedAt: -1 });
tradeInSchema.index({ 'items.imeis': 1 });
tradeInSchema.index({ purchaseId: 1 });
tradeInSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = require('../lib/tenantModel')('TradeIn', tradeInSchema);
