const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
    sku: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, default: 'piece' },
    serialNumbers: [{ type: String, trim: true }],
    /** Per-serial colour map: { [serialNumber]: colour }. Lets a single line item carry multiple colours. */
    serialColours: { type: Map, of: String, default: undefined },
    /** Condition/grade (e.g. A, D, NEW) */
    grade: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    colour: { type: String, trim: true, default: '' },
    brandModel: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    /** Snapshot at sale time for COGS; from inventory (Purchase item purchasePrice) or Product fallback. Do not change after sale. */
    unit_cost_at_sale: { type: Number, default: 0, min: 0 },
    /** True when cost could not be resolved from inventory (COGS may be understated). */
    cost_missing: { type: Boolean, default: false },
    /** Traceability: purchase and item that supplied cost (serial or qty). */
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

/** One entry per follow-up payment recorded against a sale (e.g. customer paid 50% on POS, balance later).
 *  Initial payments at sale creation are NOT duplicated here — only post-creation top-ups via take-payment. */
const paymentHistoryItemSchema = new mongoose.Schema({
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'card', 'credit', 'bank'], required: true },
    note: { type: String, trim: true, default: '', maxlength: [500, 'Note cannot exceed 500 characters'] },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: Date.now }
}, { _id: true });

const saleSchema = new mongoose.Schema({
    reference: { type: String, unique: true, trim: true },
    type: { type: String, enum: ['retail', 'wholesale', 'repair'], required: true },
    items: [saleItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ['flat', 'percent'], default: 'flat' },
    discountValue: { type: Number, default: 0, min: 0 },
    // Wholesale-only
    previousBalance: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String },
    payments: { type: paymentBreakdownSchema, default: () => ({}) },
    /** Follow-up partial-payment history. Each entry already counted in `payments` totals + `amountDue`. */
    paymentHistory: { type: [paymentHistoryItemSchema], default: [] },
    bankAccount: { type: String },
    // Retail / repair: single method
    paymentMethod: { type: String, enum: ['cash', 'card', 'credit', 'bank'] },
    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** Business event time (sale completed); stored UTC. When null, use createdAt. */
    occurredAt: { type: Date, default: null },
    /** When type is 'repair', link to the repair ticket (payment taken from repair) */
    repairId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repair', default: null },
    /** When type is 'repair': 'deposit' or 'full' */
    paymentKind: { type: String, enum: ['deposit', 'full'], default: 'full' },
    /** Location where sale occurred (nullable for legacy data; new sales should set this). */
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    /** Tenant for SaaS isolation. Set from req.user.tenantId on create. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] },
    /** active = normal sale; voided = cancelled (soft delete). Default active. */
    status: { type: String, enum: ['active', 'voided'], default: 'active' },
    voidedAtUtc: { type: Date, default: null },
    voidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, trim: true, default: null },
    note: { type: String, trim: true, default: '', maxlength: [2000, 'Note cannot exceed 2000 characters'] }
}, { timestamps: true, optimisticConcurrency: true });

/** Format: INV-000001, INV-000002, ... (6-digit sequence) */
saleSchema.pre('save', async function (next) {
    if (this.isNew && !this.reference) {
        const SaleModel = this.constructor;
        const last = await SaleModel.findOne({ reference: /^INV-\d{6}$/ })
            .sort({ reference: -1 })
            .select('reference')
            .lean();
        let seq = 1;
        if (last && last.reference) {
            const match = last.reference.match(/^INV-(\d{6})$/);
            if (match) seq = parseInt(match[1], 10) + 1;
        }
        this.reference = `INV-${String(seq).padStart(6, '0')}`;
    }
    next();
});

saleSchema.index({ locationId: 1 });
saleSchema.index({ tenantId: 1 });
saleSchema.index({ createdAt: -1 });
saleSchema.index({ status: 1 });
// Compound: covers getSales default query { tenantId, status: {$ne:'voided'} } sorted by createdAt
saleSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Compound: covers getSales with locationId filter
saleSchema.index({ tenantId: 1, status: 1, locationId: 1, createdAt: -1 });
// reference already has unique index from schema definition
// Covers customerName search
saleSchema.index({ customerName: 1 });

/** Match only non-voided sales (for dashboards, lists, reporting). */
saleSchema.statics.activeOnly = function () {
  return this.find({ status: { $ne: 'voided' } });
};

module.exports = require('../lib/tenantModel')('Sale', saleSchema);
