const mongoose = require('mongoose');

const PAYMENT_METHODS = ['Cash', 'BankTransfer', 'Card', 'PettyCash', 'OnAccount', 'Other'];
const STATUSES = ['Draft', 'Submitted', 'Approved', 'Paid', 'Rejected', 'Voided'];
const LINKED_ENTITY_TYPES = ['RepairTicket', 'Parcel', 'PurchaseOrder', 'Other'];

const attachmentSchema = new mongoose.Schema({
    filename: { type: String, required: true, trim: true },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    storageKey: { type: String, trim: true },
    url: { type: String, trim: true },
}, { _id: true });

const expenseSchema = new mongoose.Schema({
    occurredAtUtc: { type: Date, required: true, default: Date.now },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    vendorName: { type: String, trim: true, default: '' },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseCategory', required: true },
    description: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    amountNet: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, required: true, min: 0, default: 0 },
    amountGross: { type: Number, required: true, min: 0 },
    vatRate: { type: Number, default: 0, min: 0, max: 100 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentReference: { type: String, trim: true, default: '' },
    branchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    linkedEntityType: { type: String, enum: LINKED_ENTITY_TYPES, default: null },
    linkedEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: STATUSES, default: 'Draft' },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAtUtc: { type: Date, default: null },
    voidReason: { type: String, trim: true, default: null },
    attachments: [attachmentSchema],
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true,
    collection: 'expenses'
});

expenseSchema.index({ occurredAtUtc: -1 });
expenseSchema.index({ tenantId: 1 });
expenseSchema.index({ categoryId: 1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ createdByUserId: 1 });
expenseSchema.index({ approvedByUserId: 1 });
expenseSchema.index({ paymentMethod: 1 });
// Compound: covers takingsDashboard expense aggregation { tenantId, status:'approved', occurredAtUtc range }
expenseSchema.index({ tenantId: 1, status: 1, occurredAtUtc: -1 });

expenseSchema.pre('save', function (next) {
    if (this.isModified('amountNet') || this.isModified('vatAmount')) {
        this.amountGross = Math.round((Number(this.amountNet) + Number(this.vatAmount)) * 100) / 100;
    }
    next();
});

module.exports = require('../lib/tenantModel')('Expense', expenseSchema);
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.STATUSES = STATUSES;
module.exports.LINKED_ENTITY_TYPES = LINKED_ENTITY_TYPES;
