/**
 * Append-only payment ledger. One source of truth for takings by method and by account.
 * IN = money into pot (sale payment, transfer in). OUT = money out (refund, transfer out).
 */
const mongoose = require('mongoose');

const METHODS = ['cash', 'bank', 'card', 'credit', 'transfer', 'refund'];
const DIRECTIONS = ['in', 'out'];
const ENTITY_TYPES = ['Sale', 'SalesReturn', 'MoneyTransfer', 'SaleVoid'];

const paymentLedgerEntrySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: 128 },
  occurredAtUtc: { type: Date, required: true, default: Date.now },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAccount', required: true },
  method: { type: String, enum: METHODS, required: true },
  direction: { type: String, enum: DIRECTIONS, required: true },
  amount: { type: Number, required: true },
  entityType: { type: String, enum: ENTITY_TYPES, required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, collection: 'payment_ledger_entries' });

paymentLedgerEntrySchema.index({ tenantId: 1, occurredAtUtc: 1 });
paymentLedgerEntrySchema.index({ tenantId: 1, accountId: 1, occurredAtUtc: 1 });
paymentLedgerEntrySchema.index({ entityType: 1, entityId: 1 });

module.exports = require('../lib/tenantModel')('PaymentLedgerEntry', paymentLedgerEntrySchema);
module.exports.METHODS = METHODS;
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.ENTITY_TYPES = ENTITY_TYPES;
