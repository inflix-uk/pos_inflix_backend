/**
 * Payment pots (cash drawer, bank, card terminal, receivable).
 * Used for ledger-based takings and money transfer.
 */
const mongoose = require('mongoose');

const PAYMENT_ACCOUNT_TYPES = ['cash_drawer', 'bank', 'card', 'receivable'];

const paymentAccountSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: 128 },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: PAYMENT_ACCOUNT_TYPES, required: true },
  /** Cash drawers are usually per location; bank/card/receivable often tenant-wide. */
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true, collection: 'payment_accounts' });

paymentAccountSchema.index({ tenantId: 1, isActive: 1 });
paymentAccountSchema.index({ tenantId: 1, locationId: 1 });

module.exports = require('../lib/tenantModel')('PaymentAccount', paymentAccountSchema);
module.exports.PAYMENT_ACCOUNT_TYPES = PAYMENT_ACCOUNT_TYPES;
