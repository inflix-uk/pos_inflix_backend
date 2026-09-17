const mongoose = require('mongoose');
const { WHATSAPP_SAFETY_DEFAULTS: DEFAULTS } = require('../config/whatsappSafety');

/**
 * Per-tenant WhatsApp sending safety settings (single document per tenant DB).
 * Enforced by services/whatsappQueueService.js (enqueue) and
 * services/whatsappQueueWorker.js (send time).
 */
const whatsappSettingsSchema = new mongoose.Schema({
    messageDelayMinSeconds: { type: Number, default: DEFAULTS.messageDelayMinSeconds },
    messageDelayMaxSeconds: { type: Number, default: DEFAULTS.messageDelayMaxSeconds },
    hourlyLimit: { type: Number, default: DEFAULTS.hourlyLimit },
    dailyLimit: { type: Number, default: DEFAULTS.dailyLimit },
    dailyCapPerRecipient: { type: Number, default: DEFAULTS.dailyCapPerRecipient },
    duplicateWindowMinutes: { type: Number, default: DEFAULTS.duplicateWindowMinutes },
    // Worker bookkeeping, not user-editable: after each send the worker pushes
    // this forward by a random delay; nothing is sent before it.
    nextSendEligibleAt: { type: Date, default: () => new Date(0) },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
    timestamps: true,
});

whatsappSettingsSchema.statics.getSettings = async function () {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('WhatsappSettings', whatsappSettingsSchema);
