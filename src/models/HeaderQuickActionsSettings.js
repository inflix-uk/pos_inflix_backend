const mongoose = require('mongoose');

/**
 * Header quick-action button visibility (singleton per tenant).
 * Controls which shortcut buttons appear in the top nav bar.
 */
const headerQuickActionsSettingsSchema = new mongoose.Schema({
    showNewSale: { type: Boolean, default: true },
    showNewRepair: { type: Boolean, default: true },
    showParcel: { type: Boolean, default: true },
    showReturn: { type: Boolean, default: true },
    showSalesModeToggle: { type: Boolean, default: true },
    showAccounts: { type: Boolean, default: true },
    showStockList: { type: Boolean, default: true },
    updatedByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

headerQuickActionsSettingsSchema.statics.getSettings = async function () {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('HeaderQuickActionsSettings', headerQuickActionsSettingsSchema);
