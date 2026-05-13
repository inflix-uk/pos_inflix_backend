const mongoose = require('mongoose');

/**
 * Ledger entries for customer and supplier accounts.
 * Customer: type 'sale' => +amount (they owe us), 'payment_in' => -amount (they paid), 'opening_balance' => balance brought forward.
 * Supplier: type 'purchase' => +amount (we owe), 'payment_out' => -amount (we paid).
 * Balance = sum(amount) for that account.
 */
const ledgerEntrySchema = new mongoose.Schema({
    accountType: {
        type: String,
        enum: ['customer', 'supplier'],
        required: true
    },
    accountId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'accountModel'
    },
    accountModel: {
        type: String,
        enum: ['Customer', 'Supplier'],
        required: true
    },
    type: {
        type: String,
        enum: ['sale', 'payment_in', 'purchase', 'payment_out', 'opening_balance', 'refund'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    referenceLabel: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    /** Business event time when different from created_at; stored UTC. */
    occurredAt: { type: Date, default: null },
    paymentMethod: {
        type: String,
        enum: ['cash', 'bank', 'card', ''],
        default: ''
    },
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

ledgerEntrySchema.index({ accountType: 1, accountId: 1, date: -1 });
ledgerEntrySchema.index({ referenceId: 1, type: 1 });
ledgerEntrySchema.index({ deletedAt: 1 });

module.exports = require('../lib/tenantModel')('LedgerEntry', ledgerEntrySchema);
