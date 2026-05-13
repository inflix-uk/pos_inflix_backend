const mongoose = require('mongoose');

const COST_CENTRES = ['Sales', 'Repairs', 'Warehouse', 'Admin', 'General'];

const expenseCategorySchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true },
    code: { type: String, trim: true, sparse: true },
    parentCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseCategory', default: null },
    defaultVatRate: { type: Number, default: 0, min: 0, max: 100 },
    vatType: { type: String, trim: true, default: '' },
    costCentre: { type: String, enum: COST_CENTRES, default: 'General' },
    requiresAttachment: { type: Boolean, default: false },
    requiresManagerApproval: { type: Boolean, default: false },
    approvalThresholdAmount: { type: Number, default: null, min: 0 },
    isActive: { type: Boolean, default: true },
}, {
    timestamps: true,
    collection: 'expense_categories'
});

expenseCategorySchema.index({ isActive: 1 });
expenseCategorySchema.index({ costCentre: 1 });

module.exports = require('../lib/tenantModel')('ExpenseCategory', expenseCategorySchema);
module.exports.COST_CENTRES = COST_CENTRES;
