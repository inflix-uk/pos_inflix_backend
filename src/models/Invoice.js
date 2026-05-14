const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
    sku: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, default: 'piece' },
    serialNumbers: [{ type: String, trim: true }],
    /** Per-serial colour map: { [serialNumber]: colour }. */
    serialColours: { type: Map, of: String, default: undefined },
    grade: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    colour: { type: String, trim: true, default: '' },
    brandModel: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    /** Snapshot of cost at invoice time (for reporting only — invoices do not consume inventory). */
    unit_cost_at_sale: { type: Number, default: 0, min: 0 },
    cost_missing: { type: Boolean, default: false },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    purchaseItemId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { _id: true });

const paymentBreakdownSchema = new mongoose.Schema({
    cash: { type: Number, default: 0, min: 0 },
    card: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    bank: { type: Number, default: 0, min: 0 },
    split: { type: Number, default: 0, min: 0 }
}, { _id: false });

const paymentHistoryItemSchema = new mongoose.Schema({
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'card', 'credit', 'bank'], required: true },
    note: { type: String, trim: true, default: '', maxlength: [500, 'Note cannot exceed 500 characters'] },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: Date.now }
}, { _id: true });

const invoiceSchema = new mongoose.Schema({
    reference: { type: String, unique: true, trim: true },
    type: { type: String, enum: ['retail', 'wholesale', 'repair'], required: true },
    items: [invoiceItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    /** Tax category applied — mirrors the field used in purchases/add (Tax model in settings). */
    taxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tax', default: null },
    taxName: { type: String, trim: true, default: '' },
    taxRate: { type: Number, default: 0, min: 0 },
    taxType: { type: String, enum: ['percentage', 'flat', ''], default: '' },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ['flat', 'percent'], default: 'flat' },
    discountValue: { type: Number, default: 0, min: 0 },
    previousBalance: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String },
    payments: { type: paymentBreakdownSchema, default: () => ({}) },
    paymentHistory: { type: [paymentHistoryItemSchema], default: [] },
    bankAccount: { type: String },
    paymentMethod: { type: String, enum: ['cash', 'card', 'credit', 'bank'] },
    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    occurredAt: { type: Date, default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] },
    status: { type: String, enum: ['active', 'voided'], default: 'active' },
    voidedAtUtc: { type: Date, default: null },
    voidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, trim: true, default: null },
    note: { type: String, trim: true, default: '', maxlength: [2000, 'Note cannot exceed 2000 characters'] }
}, { timestamps: true, optimisticConcurrency: true });

/** Format: INVC-000001, INVC-000002, ... (6-digit sequence) — distinct from sales INV- prefix. */
invoiceSchema.pre('save', async function (next) {
    if (this.isNew && !this.reference) {
        const InvoiceModel = this.constructor;
        const last = await InvoiceModel.findOne({ reference: /^INVC-\d{6}$/ })
            .sort({ reference: -1 })
            .select('reference')
            .lean();
        let seq = 1;
        if (last && last.reference) {
            const match = last.reference.match(/^INVC-(\d{6})$/);
            if (match) seq = parseInt(match[1], 10) + 1;
        }
        this.reference = `INVC-${String(seq).padStart(6, '0')}`;
    }
    next();
});

invoiceSchema.index({ locationId: 1 });
invoiceSchema.index({ tenantId: 1 });
invoiceSchema.index({ createdAt: -1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
invoiceSchema.index({ tenantId: 1, status: 1, locationId: 1, createdAt: -1 });
invoiceSchema.index({ customerName: 1 });

invoiceSchema.statics.activeOnly = function () {
    return this.find({ status: { $ne: 'voided' } });
};

module.exports = require('../lib/tenantModel')('Invoice', invoiceSchema);
