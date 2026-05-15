const mongoose = require('mongoose');

const inventorySettingsSchema = new mongoose.Schema({
    /** When true, creating a new parcel updates sale price on all existing purchase items with the same variant (category, grade, brand, model, capacity). */
    syncSalePriceToSameVariant: {
        type: Boolean,
        default: true
    },
    /** Global default: product is "low stock" when availableQty <= this. Used when product.lowStockThreshold is null. */
    defaultLowStockThreshold: {
        type: Number,
        default: 5,
        min: 0
    },
    /** When true, Create Sales shows inventory across ALL locations regardless of the selected location filter. When false (default), inventory is filtered to the selected location's items.sendTo only. */
    syncAllLocations: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

inventorySettingsSchema.statics.getSettings = async function () {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('InventorySettings', inventorySettingsSchema);
