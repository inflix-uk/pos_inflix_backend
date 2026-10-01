const mongoose = require('mongoose');

/**
 * The tenant's WhatsApp pairing (Baileys creds + Signal keys), one document per entry.
 * `_id` is "creds" or "<key type>:<key id>"; `value` is the entry as BufferJSON text.
 * Kept in the tenant database rather than on the server's disk so a redeploy does not
 * log the shop out of WhatsApp. Read and written only by services/whatsappAuthStore.js.
 */
const whatsappAuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    value: { type: String, required: true },
}, {
    collection: 'whatsappauth',
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: true },
});

module.exports = require('../lib/tenantModel')('WhatsappAuth', whatsappAuthSchema);
