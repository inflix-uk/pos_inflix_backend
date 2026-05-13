const mongoose = require('mongoose');

const repairSchema = new mongoose.Schema({
    /** Unique reference e.g. REP-000001 */
    reference: { type: String, unique: true, trim: true },
    /** Customer (optional - walk-in repairs) */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, required: true, trim: true, maxlength: [200, 'Customer name cannot exceed 200 characters'] },
    contactPhone: { type: String, trim: true, default: '' },
    contactEmail: { type: String, trim: true, default: '' },
    /** Device description (legacy single device; required when devices[] empty) */
    deviceDescription: { type: String, trim: true, default: '' },
    /** IMEI or serial number (legacy) */
    serialNumber: { type: String, trim: true, default: '' },
    /** Multiple devices on this ticket (when set, takes precedence over legacy fields) */
    devices: [{
        deviceDescription: { type: String, trim: true, default: '' },
        serialNumber: { type: String, trim: true, default: '' },
        problemType: { type: String, trim: true, default: '' },
        devicePassword: { type: String, trim: true, default: '' },
        estimatedCost: { type: Number, default: null, min: 0 },
        notes: { type: String, trim: true, default: '' }
    }],
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'waiting_parts', 'completed', 'cancelled', 'collected', 'redo'],
        default: 'pending'
    },
    receivedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    collectedAt: { type: Date, default: null },
    estimatedCost: { type: Number, default: null, min: 0 },
    actualCost: { type: Number, default: null, min: 0 },
    notes: { type: String, default: '' },
    internalNotes: { type: String, default: '' },
    /** Device password / passcode provided by customer */
    devicePassword: { type: String, trim: true, default: '' },
    /** Problem type (legacy single device) */
    problemType: { type: String, trim: true, default: '' },
    /** Notify customer via email when ticket is created/updated */
    notifyViaEmail: { type: Boolean, default: true },
    /** Services and parts line items for estimate/invoice */
    repairItems: [{
        description: { type: String, required: true, trim: true },
        amount: { type: Number, required: true, min: 0 }
    }],
    /** Optional link to sale (e.g. device sold then came back for repair) */
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    /** All payments/deposits for this repair (newest last); saleId = latest for backward compat */
    paymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Sale' }],
    /** Optional link to purchase return (sent to supplier for repair) */
    purchaseReturnId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseReturn', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Location where repair is performed (nullable for legacy data; new repairs should set this). */
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    /** Tenant identity for SaaS; set from req.user.tenantId on create. Nullable for legacy. */
    tenantId: { type: String, default: null, trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] },
    /** London date key (YYYY-MM-DD) of createdAt for month-scoped usage (maxRepairsPerMonth). */
    londonDateKey: { type: String, default: null, trim: true, maxlength: [10, 'London date key cannot exceed 10 characters'] }
}, {
    timestamps: true,
    collection: 'repairs'
});

/** Set londonDateKey from createdAt for usage queries; generate REP-XXXXXX if new. */
repairSchema.pre('save', async function (next) {
    const { getLondonDateKey } = require('../utils/dateKey');
    const date = this.createdAt || new Date();
    this.londonDateKey = getLondonDateKey(date);
    if (this.isNew && !this.reference) {
        const Repair = this.constructor;
        const last = await Repair.findOne().sort({ reference: -1 }).select('reference').lean();
        const num = last?.reference?.replace(/^REP-0*/, '') || '0';
        const nextNum = String(parseInt(num, 10) + 1).padStart(6, '0');
        this.reference = `REP-${nextNum}`;
    }
    next();
});

repairSchema.index({ locationId: 1 });
repairSchema.index({ status: 1 });
repairSchema.index({ tenantId: 1, londonDateKey: 1 });
// Compound: covers getRepairs default query sorted by createdAt
repairSchema.index({ tenantId: 1, createdAt: -1 });
// Compound: covers getRepairs with status filter
repairSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

module.exports = require('../lib/tenantModel')('Repair', repairSchema);
