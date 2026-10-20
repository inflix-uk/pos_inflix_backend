const mongoose = require('mongoose');

/**
 * Images attached to a trade-in: ID document (front/back) and the customer's signature.
 * Stored in the tenant DB (not a public CDN) because ID documents are personal data;
 * they are only served to logged-in staff with trade-in permission.
 * One file per kind per trade-in; uploading again replaces it.
 */
const FILE_KINDS = ['id_front', 'id_back', 'signature'];

const tradeInFileSchema = new mongoose.Schema({
    tradeInId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradeIn', required: true },
    kind: { type: String, enum: FILE_KINDS, required: true },
    mimeType: { type: String, enum: ['image/jpeg', 'image/png'], required: true },
    data: { type: Buffer, required: true },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    uploadedVia: { type: String, enum: ['desktop', 'phone'], default: 'desktop' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: 128 },
    /** Copied from the draft trade-in; cleared on completion so the file is kept. */
    expiresAt: { type: Date, default: null }
}, {
    timestamps: true,
    collection: 'tradeinfiles'
});

tradeInFileSchema.index({ tradeInId: 1, kind: 1 }, { unique: true });
tradeInFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = require('../lib/tenantModel')('TradeInFile', tradeInFileSchema);
