const mongoose = require('mongoose');

/**
 * Immutable audit log for system-wide key operations.
 * Never delete audit logs. All timestamps stored in UTC.
 */
const auditLogSchema = new mongoose.Schema({
    entityType: {
        type: String,
        required: true,
        enum: [
            'Sale', 'Payment', 'LedgerEntry', 'Product', 'Purchase', 'Parcel',
            'Refund', 'SalesReturn', 'StockMove', 'Inventory', 'SerialHistory',
            'Customer', 'Supplier', 'Category', 'VariantAttribute', 'Other'
        ]
    },
    entityId: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: [
            'CREATE', 'UPDATE', 'DELETE', 'VOID', 'REFUND', 'RETURN',
            'STATUS_CHANGE', 'PAYMENT', 'ADJUSTMENT', 'SHIP', 'TRACKING_ADDED'
        ]
    },
    /** JSON: { before: {...}, after: {...} or patch description */
    changes: { type: mongoose.Schema.Types.Mixed },
    performedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    /** UTC; display in UI as Europe/London 24h */
    performedAt: { type: Date, default: Date.now },
    source: {
        type: String,
        enum: ['UI', 'API', 'import', 'system'],
        default: 'API'
    },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    sessionId: { type: String, default: '' }
}, {
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ performedBy: 1, performedAt: -1 });
auditLogSchema.index({ performedAt: -1 });

module.exports = require('../lib/tenantModel')('AuditLog', auditLogSchema);
