const mongoose = require('mongoose');

/**
 * Company-wide general settings (singleton).
 * - Sales: default account auto-select on Create Sales; sales mode (wholesale vs retail walk-in).
 */
const generalSettingsSchema = new mongoose.Schema({
    /** When true, Create Sales page auto-selects defaultSalesAccountId on load (if no customer already selected). */
    salesAutoSelectAccountEnabled: {
        type: Boolean,
        default: false
    },
    /** Customer or Supplier _id to auto-select on Create Sales when salesAutoSelectAccountEnabled is true. Resolved in API from Customer or Supplier collection. */
    defaultSalesAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    /** When true, Create Sales runs in Retail (Walk-in) mode: customer not required (Walk-in used), no credit, full payment required. */
    retailModeEnabled: {
        type: Boolean,
        default: false
    },
    updatedByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

generalSettingsSchema.statics.getSettings = async function () {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('GeneralSettings', generalSettingsSchema);
