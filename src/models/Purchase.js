const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
    name: { type: String },
    barcode: { type: String },
    sendTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Location'
    },
    tax: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tax'
    },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category'
    },
    subCategory: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory'
    },
    grade: { type: String },
    brand: { type: String },
    brandModel: { type: String },
    capacity: { type: String },
    colour: { type: String },
    // Ordered variant attributes (same order as category): [{ slug, value }] - values stored in UPPERCASE
    variantValues: [{
        slug: { type: String, required: true },
        value: { type: String, required: true }
    }],
    purchasePrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    imeis: [{ type: String }],
    // Per-IMEI SID, aligned to entries in `imeis` by index. New purchases populate this.
    // Legacy purchases use the item-level `serialItemIdNumber` below until migrated.
    imeiSerials: [{
        _id: false,
        imei: { type: String },
        serialItemIdNumber: { type: String }
    }],
    serialItemIdNumber: { type: String },
    quantity: { type: Number, default: 0 },
    isOtherItem: { type: Boolean, default: false },
    /** Per-item-group note. Each saved row carries its own note independent of the parcel-level note. */
    note: { type: String }
});

const purchaseSchema = new mongoose.Schema({
    purchaseNumber: {
        type: String,
        required: true,
        unique: true
    },
    supplier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Supplier',
        required: false
    },
    account: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'accountModel'
    },
    accountModel: {
        type: String,
        enum: ['Supplier', 'Customer'],
        default: 'Supplier'
    },
    parcelNumber: { type: String },
    date: { type: Date, default: Date.now },
    currency: {
        type: String,
        enum: ['GBP', 'USD', 'EUR'],
        default: 'GBP'
    },
    note: { type: String },
    imeiQuantity: { type: Number, default: 0 },
    otherQuantity: { type: Number, default: 0 },
    items: [purchaseItemSchema],
    totalIMEIs: { type: Number, default: 0 },
    totalOtherQuantity: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['Received', 'Pending', 'Ordered'],
        default: 'Received'
    },
    paymentStatus: {
        type: String,
        enum: ['Paid', 'Unpaid', 'Partial'],
        default: 'Unpaid'
    },
    /** Parcel completion: Completed when entered qty matches expected; In Process otherwise. User can change. */
    completionStatus: {
        type: String,
        enum: ['In Process', 'Completed'],
        default: 'In Process'
    },
    grandTotal: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    /** Business event time (e.g. parcel shipped, status changed); stored UTC. */
    occurredAt: { type: Date, default: null },
    /** Tenant for SaaS isolation. Set from req.user.tenantId on create. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true
});

// Index for find-by-serial (wholesale/POS scan): avoids full collection scan
purchaseSchema.index({ 'items.imeis': 1 });
// Compound: legacyFindInStockSerials runs Purchase.find({ tenantId, 'items.imeis': { $in: [...] } }).
// Tenant-scoped multikey index lets the planner filter both predicates from one index.
purchaseSchema.index({ tenantId: 1, 'items.imeis': 1 });
purchaseSchema.index({ tenantId: 1 });
// Compound: covers getPurchases pagination sorted by createdAt
purchaseSchema.index({ tenantId: 1, createdAt: -1 });
// Covers location filter on purchase items (post-query but helps sendTo lookups)
purchaseSchema.index({ 'items.sendTo': 1 });

// ── Sales typeahead (POS create-sales item search) ───────────────────────────
// Tenant + barcode lookup (scanner / exact-match path). Sparse: many items have no barcode.
purchaseSchema.index({ tenantId: 1, 'items.barcode': 1 }, { sparse: true });
// Tenant-scoped lookups by item brand/model/category for typeahead $or branches.
// MongoDB only indexes one array path per compound, so these are single-field multikey-friendly.
purchaseSchema.index({ tenantId: 1, 'items.brand': 1 });
purchaseSchema.index({ tenantId: 1, 'items.brandModel': 1 });
purchaseSchema.index({ tenantId: 1, 'items.category': 1 });
purchaseSchema.index({ tenantId: 1, 'items.name': 1 }, { sparse: true });
// Wildcard text index over searchable item fields. Use for $text queries when
// driver requests it; $regex queries still benefit from the field-level indexes above.
purchaseSchema.index(
    {
        'items.name': 'text',
        'items.barcode': 'text',
        'items.brand': 'text',
        'items.brandModel': 'text',
        'items.capacity': 'text',
        'items.colour': 'text',
        'items.grade': 'text',
        'items.variantValues.value': 'text'
    },
    {
        name: 'PurchaseItems_TextIndex',
        weights: {
            'items.barcode': 10,
            'items.name': 5,
            'items.brand': 4,
            'items.brandModel': 4,
            'items.capacity': 2,
            'items.colour': 2,
            'items.grade': 2,
            'items.variantValues.value': 1
        },
        default_language: 'none'
    }
);

module.exports = require('../lib/tenantModel')('Purchase', purchaseSchema);
