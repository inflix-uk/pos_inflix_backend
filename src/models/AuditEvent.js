const mongoose = require('mongoose');

/** Action enum for fast filtering */
const AUDIT_ACTIONS = [
    'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'ACCESS_DENIED',
    'CREATE_SALE', 'EDIT_SALE', 'VOID_SALE', 'DELETE_SALE', 'SALE_HARD_DELETED',
    'CREATE_RETURN', 'EDIT_RETURN', 'DELETE_RETURN', 'REFUND_ISSUED', 'STORE_CREDIT',
    'PAYMENT_ADDED', 'PAYMENT_ADJUSTMENT', 'CREDIT_NOTE', 'REFUND_ADDED',
    'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DELETED', 'STOCK_ADJUSTED',
    'PARCEL_CREATED', 'PARCEL_UPDATED', 'PARCEL_STATUS_CHANGED', 'PARCEL_ITEM_DELETED',
    'PURCHASE_RETURN_CREATED',
    'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_DELETED',
    'USER_CREATED', 'USER_UPDATED', 'USER_DISABLED', 'USER_ENABLED', 'USER_DELETED', 'PASSWORD_RESET',
    'ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DELETED', 'ROLE_PERMISSIONS_CHANGED', 'USER_ROLES_CHANGED',
    'PLATFORM_TENANT_CREATED', 'PLATFORM_TENANT_UPDATED', 'PLATFORM_TENANT_DELETED', 'PLATFORM_ENTITLEMENTS_UPDATED',
    'CREATE', 'UPDATE', 'DELETE', 'VOID', 'REFUND', 'RETURN', 'STATUS_CHANGE', 'PAYMENT', 'ADJUSTMENT', 'SHIP', 'TRACKING_ADDED',
    'EXPENSE_CATEGORY_CREATED', 'EXPENSE_CATEGORY_UPDATED', 'EXPENSE_CATEGORY_ARCHIVED',
    'EXPENSE_CREATED', 'EXPENSE_UPDATED', 'EXPENSE_SUBMITTED', 'EXPENSE_APPROVED', 'EXPENSE_REJECTED', 'EXPENSE_PAID', 'EXPENSE_VOIDED',
    'STOCK_TRANSFER_CREATED', 'STOCK_TRANSFER_UPDATED', 'STOCK_TRANSFER_DISPATCHED', 'STOCK_TRANSFER_RECEIVED', 'STOCK_TRANSFER_CANCELLED',
    'STOCK_TRANSFER_SERIAL_ADDED', 'STOCK_TRANSFER_SERIAL_REMOVED',
    'STOCK_ADJUSTMENT_CREATED', 'STOCK_ADJUSTMENT_UPDATED', 'STOCK_ADJUSTMENT_LINE_ADDED', 'STOCK_ADJUSTMENT_LINE_REMOVED',
    'STOCK_ADJUSTMENT_SERIAL_ADDED', 'STOCK_ADJUSTMENT_SERIAL_REMOVED', 'STOCK_ADJUSTMENT_POSTED', 'STOCK_ADJUSTMENT_CANCELLED',
    'LOW_STOCK_THRESHOLD_GLOBAL_UPDATED', 'LOW_STOCK_THRESHOLD_PRODUCT_UPDATED',
    'LABELS_PRINTED', 'SETTINGS_UPDATED', 'PRINT_JOB_SENT', 'SETTINGS_PRINTING_UPDATED'
];

const ENTITY_TYPES = [
    'Sale', 'SalesReturn', 'Payment', 'LedgerEntry', 'Product', 'Purchase', 'PurchaseReturn', 'Parcel',
    'Customer', 'Supplier', 'StockMove', 'Inventory', 'SerialHistory', 'Category', 'VariantAttribute', 'User', 'Role', 'Permission', 'Route', 'Other', 'Settings',
    'ExpenseCategory', 'Expense', 'StockTransfer', 'StockAdjustment',
    'Tenant', 'TenantSubscription'
];

/**
 * Append-only activity/audit log. Immutable (no update/delete).
 * All timestamps stored in UTC; display in UI as Europe/London 24h.
 * Optional tamper-evident: prev_hash + hash chain.
 */
const auditEventSchema = new mongoose.Schema({
    occurredAtUtc: { type: Date, required: true, default: Date.now },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    entityType: { type: String, required: true, enum: ENTITY_TYPES },
    entityId: { type: mongoose.Schema.Types.Mixed, required: true },
    success: { type: Boolean, default: true },
    message: { type: String, default: '' },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    invoiceNo: { type: String, default: '' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    imei: { type: String, default: '' },
    amount: { type: Number, default: null },
    paymentMethod: { type: String, default: null },

    source: { type: String, enum: ['UI', 'API', 'import', 'system'], default: 'API' },
    ipAddress: { type: String, default: '' },
    deviceId: { type: String, default: '' },
    userAgent: { type: String, default: '' },

    diffJson: { type: mongoose.Schema.Types.Mixed },
    beforeJson: { type: mongoose.Schema.Types.Mixed },
    afterJson: { type: mongoose.Schema.Types.Mixed },
    metaJson: { type: mongoose.Schema.Types.Mixed },

    prevHash: { type: String, default: null },
    hash: { type: String, default: null },
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: false,
    collection: 'auditevents'
});

auditEventSchema.index({ occurredAtUtc: -1 });
auditEventSchema.index({ tenantId: 1, occurredAtUtc: -1 });
auditEventSchema.index({ actorUserId: 1, occurredAtUtc: -1 });
auditEventSchema.index({ customerId: 1, occurredAtUtc: -1 });
auditEventSchema.index({ saleId: 1, occurredAtUtc: -1 });
auditEventSchema.index({ invoiceNo: 1, occurredAtUtc: -1 });
auditEventSchema.index({ productId: 1, occurredAtUtc: -1 });
auditEventSchema.index({ imei: 1, occurredAtUtc: -1 });
auditEventSchema.index({ action: 1, occurredAtUtc: -1 });
auditEventSchema.index({ entityType: 1, occurredAtUtc: -1 });
auditEventSchema.index({ success: 1, occurredAtUtc: -1 });
auditEventSchema.index({ source: 1, occurredAtUtc: -1 });

module.exports = require('../lib/tenantModel')('AuditEvent', auditEventSchema);
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
module.exports.ENTITY_TYPES = ENTITY_TYPES;
