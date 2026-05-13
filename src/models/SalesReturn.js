const mongoose = require('mongoose');

const salesReturnItemSchema = new mongoose.Schema({
    product: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, default: '' },
    netUnitPrice: { type: Number, required: true, default: 0, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    discount: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, required: true, default: 0, min: 0 },
    serialNumbers: [{ type: String, trim: true }],
    /** Where this line goes: restock (sellable), damaged, refurb, return_to_supplier */
    returnDestination: { type: String, enum: ['restock', 'damaged', 'refurb', 'return_to_supplier'], default: 'restock' },
    /** Snapshot at return time for COGS reversal; from original sale line unit_cost_at_sale. */
    unit_cost_at_return: { type: Number, default: 0, min: 0 }
}, { _id: true });

const salesReturnSchema = new mongoose.Schema({
    reference: { type: String, trim: true, unique: true, sparse: true },
    /** Original sale invoice reference (e.g. INV-000002) for linking and search */
    linkedInvoiceRef: { type: String, trim: true },
    customerName: { type: String, required: true, trim: true },
    date: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ['Received', 'Pending', 'Ordered'], default: 'Pending' },
    paymentStatus: { type: String, enum: ['Paid', 'Unpaid', 'Pending'], default: 'Unpaid' },
    items: [salesReturnItemSchema],
    orderTax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    shipping: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    due: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0, min: 0 },
    /** Business event time (refund/return issued); stored UTC. When null, use date or createdAt. */
    occurredAt: { type: Date, default: null },
    /** Location where return was recorded (nullable for legacy). Set from linked sale when linkedInvoiceRef present, else from request. */
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    /** Tenant for SaaS isolation. Set from req.user.tenantId on create. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, { timestamps: true, optimisticConcurrency: true });

salesReturnSchema.index({ locationId: 1 });
salesReturnSchema.index({ tenantId: 1 });
// Covers getSales hasReturn filter + return status lookup by invoice refs
salesReturnSchema.index({ tenantId: 1, linkedInvoiceRef: 1 });
// Compound: covers getSalesReturns default sorted query
salesReturnSchema.index({ tenantId: 1, date: -1, createdAt: -1 });

/** Format: SR-000001, SR-000002, ... (6-digit sequence) */
salesReturnSchema.pre('save', async function (next) {
    if (this.isNew && !this.reference) {
        const SalesReturnModel = this.constructor;
        const last = await SalesReturnModel.findOne({ reference: /^SR-\d{6}$/ })
            .sort({ reference: -1 })
            .select('reference')
            .lean();
        let seq = 1;
        if (last && last.reference) {
            const match = last.reference.match(/^SR-(\d{6})$/);
            if (match) seq = parseInt(match[1], 10) + 1;
        }
        this.reference = `SR-${String(seq).padStart(6, '0')}`;
    }
    next();
});

module.exports = require('../lib/tenantModel')('SalesReturn', salesReturnSchema);
